/**
 * Разбор подписок и ссылок. Чистые функции без сети — легко тестировать.
 * Поддержка: vless://, vmess://, trojan://, ss://, hysteria2:// (hy2://).
 */

export type Proto = "vless" | "vmess" | "trojan" | "ss" | "hysteria2";

export interface ParsedKey {
  uri: string;
  proto: Proto;
  host: string;
  port: number;
  remark: string;
  security: string;
  sni: string;
}

export interface Userinfo {
  upload: number | null;
  download: number | null;
  total: number | null;
  expire: number | null;
}

const MAX_KEYS = 200;
const ALIASES: Record<string, Proto> = {
  vless: "vless",
  vmess: "vmess",
  trojan: "trojan",
  ss: "ss",
  shadowsocks: "ss",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
};

export function isSingleKey(text: string): boolean {
  return /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(text.trim());
}

function b64ToBytes(input: string): Uint8Array | null {
  let value = input.trim().replace(/-/g, "+").replace(/_/g, "/");
  value = value.replace(/\s+/g, "");
  if (!value) return null;
  value += "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function b64DecodeText(input: string): string | null {
  const bytes = b64ToBytes(input);
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function looksBase64(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes("://")) return false;
  if (trimmed.length < 16) return false;
  return /^[A-Za-z0-9+/=_\-\s]+$/.test(trimmed);
}

/** Тело подписки: base64 или plain-текст → список ссылок. */
export function decodePayload(body: string): string[] {
  let text = body ?? "";
  if (looksBase64(text)) {
    const decoded = b64DecodeText(text);
    if (decoded && decoded.includes("://")) text = decoded;
  }
  return text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0]);
}

function defaultPort(proto: Proto): number {
  return 443;
}

function parseVmess(uri: string): ParsedKey | null {
  const decoded = b64DecodeText(uri.slice("vmess://".length));
  if (!decoded) return null;
  try {
    const data = JSON.parse(decoded) as Record<string, unknown>;
    const host = String(data.add ?? "");
    if (!host) return null;
    const port = Number(data.port ?? 443) || 443;
    const tls = String(data.tls ?? "").toLowerCase();
    return {
      uri,
      proto: "vmess",
      host,
      port,
      remark: String(data.ps ?? ""),
      security: tls === "tls" || tls === "reality" ? tls : "",
      sni: String(data.sni ?? data.host ?? ""),
    };
  } catch {
    return null;
  }
}

function parseShadowsocks(uri: string): ParsedKey | null {
  const body = uri.slice("ss://".length);
  const hashIndex = body.indexOf("#");
  const remark = hashIndex >= 0 ? safeDecode(body.slice(hashIndex + 1)) : "";
  const withoutHash = hashIndex >= 0 ? body.slice(0, hashIndex) : body;
  const queryIndex = withoutHash.indexOf("?");
  const core = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

  let host = "";
  let port = 443;

  if (core.includes("@")) {
    const at = core.lastIndexOf("@");
    const netloc = core.slice(at + 1);
    const decodedUser = b64DecodeText(safeDecode(core.slice(0, at))) ?? safeDecode(core.slice(0, at));
    if (!decodedUser.includes(":")) return null;
    const [h, p] = splitHostPort(netloc);
    host = h;
    port = p;
  } else {
    const decoded = b64DecodeText(safeDecode(core));
    if (!decoded || !decoded.includes("@")) return null;
    const at = decoded.lastIndexOf("@");
    const [h, p] = splitHostPort(decoded.slice(at + 1));
    host = h;
    port = p;
  }

  if (!host) return null;
  return { uri, proto: "ss", host, port, remark, security: "", sni: "" };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitHostPort(netloc: string): [string, number] {
  if (netloc.startsWith("[")) {
    const end = netloc.indexOf("]");
    const host = netloc.slice(1, end);
    const port = Number(netloc.slice(end + 1).replace(":", "")) || 443;
    return [host, port];
  }
  const idx = netloc.lastIndexOf(":");
  if (idx < 0) return [netloc, 443];
  return [netloc.slice(0, idx), Number(netloc.slice(idx + 1)) || 443];
}

export function parseUri(uri: string): ParsedKey | null {
  const trimmed = uri.trim();
  if (!isSingleKey(trimmed)) return null;
  const scheme = trimmed.split("://", 1)[0].toLowerCase();
  const proto = ALIASES[scheme];
  if (!proto) return null;
  if (proto === "vmess") return parseVmess(trimmed);
  if (proto === "ss") return parseShadowsocks(trimmed);

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) return null;
    const port = Number(url.port) || defaultPort(proto);
    let security = (url.searchParams.get("security") ?? "").toLowerCase();
    if (!security && (proto === "trojan" || proto === "hysteria2")) security = "tls";
    return {
      uri: trimmed,
      proto,
      host,
      port,
      remark: safeDecode(url.hash.replace(/^#/, "")),
      security,
      sni: url.searchParams.get("sni") ?? url.searchParams.get("peer") ?? "",
    };
  } catch {
    return null;
  }
}

/** Текст подписки → уникальные ключи (по протоколу, хосту и порту). */
export function parseSubscription(text: string, limit = MAX_KEYS): ParsedKey[] {
  const out: ParsedKey[] = [];
  const seen = new Set<string>();
  for (const uri of decodePayload(text)) {
    if (out.length >= limit) break;
    const parsed = parseUri(uri);
    if (!parsed) continue;
    const fingerprint = `${parsed.proto}|${parsed.host.toLowerCase()}|${parsed.port}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(parsed);
  }
  return out;
}

export function parseUserinfo(header: string | null): Userinfo {
  const result: Userinfo = { upload: null, download: null, total: null, expire: null };
  if (!header) return result;
  for (const part of header.split(";")) {
    const [rawKey, rawValue] = part.split("=");
    const key = (rawKey ?? "").trim().toLowerCase();
    if (!(key in result)) continue;
    const value = Number((rawValue ?? "").trim());
    if (Number.isFinite(value)) {
      result[key as keyof Userinfo] = Math.trunc(value);
    }
  }
  return result;
}

export function withLabel(uri: string, label: string): string {
  const base = uri.split("#", 1)[0];
  return `${base}#${encodeURIComponent(label)}`;
}

/** base64-подписка в формате, который понимает Happ. */
export function buildSubscription(uris: string[]): string {
  const raw = uris.join("\n");
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
