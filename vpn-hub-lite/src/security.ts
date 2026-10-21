/** Секреты, хэши, сравнение за постоянное время, лимиты частоты. */

import type { Env } from "./types";

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 случайных байта по умолчанию — требование ТЗ. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** IP и User-Agent храним только так: соль + SHA-256, обрезанный до 32 символов. */
export async function hashValue(
  value: string,
  salt: string,
  length = 32,
): Promise<string> {
  const full = await sha256Hex(`${salt}:${value}`);
  return full.slice(0, length);
}

/** Сравнение строк без раннего выхода: важно для токенов и подписей. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** Накопительный лимит частоты в KV (для логина в админку). */
export async function kvRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const kvKey = `rl:${key}:${bucket}`;
  const current = Number((await env.CACHE.get(kvKey)) ?? "0");
  if (current >= limit) return false;
  await env.CACHE.put(kvKey, String(current + 1), {
    expirationTtl: windowSec + 5,
  });
  return true;
}

/**
 * Дешёвый лимит в памяти изолята: без записей в KV, но действует только
 * внутри одного colo. Для /sub этого достаточно — токен всё равно 32 байта.
 */
const memoryHits = new Map<string, number[]>();

export function memRateLimit(key: string, limit: number, windowSec: number): boolean {
  const now = Date.now();
  const from = now - windowSec * 1000;
  const hits = (memoryHits.get(key) ?? []).filter((ts) => ts > from);
  if (hits.length >= limit) {
    memoryHits.set(key, hits);
    return false;
  }
  hits.push(now);
  memoryHits.set(key, hits);
  if (memoryHits.size > 5000) memoryHits.clear();
  return true;
}

export async function adminCookieValue(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.ADMIN_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("vh-admin"));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
