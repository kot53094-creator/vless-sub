/**
 * Свой узел: ключи пользователей и синхронизация клиентов Xray.
 *
 * Зачем это нужно. Пока подписка состоит из чужих узлов, отозвать доступ
 * невозможно: UUID принадлежит владельцу сервера, а не нам, и квоту/срок
 * проверить нечем. Свой узел решает обе задачи:
 *
 *   • UUID выводится из токена подписки (HMAC + соль), поэтому он стабилен,
 *     принадлежит аккаунту и пропадает из конфига, как только подписка
 *     закончилась или кончился трафик;
 *   • Xray на узле ведёт счётчики по email = токен подписки, агент отдаёт
 *     их в /api/traffic, и квота становится настоящей.
 *
 * Узел может работать как есть (выход напрямую) или как цепочка: принимает
 * наш ключ, а наружу ходит через чужие узлы. Второй вариант даёт «свой ключ»
 * без покупки зарубежного сервера, но добавляет хоп и зависит от чужих IP.
 */

import { one, many } from "./db";
import { checkTokenOk, envStr } from "./security";
import type { Env, UserRow } from "./types";

/** UUID версии 4 из токена подписки: стабильный и необратимый. */
export async function uuidForToken(token: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt || "vpn-hub"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`node:${token}`));
  const bytes = new Uint8Array(signature).slice(0, 16);
  // Версия 4 и вариант RFC 4122 — иначе часть клиентов отвергает UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export interface OwnNode {
  host: string;
  port: string;
  pubkey: string;
  sid: string;
  sni: string;
  name: string;
}

/** Настройки своего узла из переменных окружения. Пусто — узел не настроен. */
export function ownNode(env: Env): OwnNode | null {
  const host = envStr(env.NODE_HOST).trim();
  const pubkey = envStr(env.NODE_PUBKEY).trim();
  if (!host || !pubkey) return null;
  return {
    host,
    port: envStr(env.NODE_PORT).trim() || "443",
    pubkey,
    sid: envStr(env.NODE_SID).trim() || "a1b2c3d4",
    sni: envStr(env.NODE_SNI).trim() || "www.microsoft.com",
    name: envStr(env.NODE_NAME).trim() || "Свой узел",
  };
}

/** Персональная ссылка на свой узел. Ключ выводится из токена подписки. */
export async function ownNodeLink(env: Env, user: UserRow | null): Promise<string> {
  const node = ownNode(env);
  if (!node || !user?.sub_token) return "";
  const uuid = await uuidForToken(user.sub_token, envStr(env.SALT));
  const query = new URLSearchParams({
    encryption: "none",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: node.sni,
    fp: "chrome",
    pbk: node.pubkey,
    sid: node.sid,
    type: "tcp",
  });
  return `vless://${uuid}@${node.host}:${node.port}?${query.toString()}#${encodeURIComponent(node.name)}`;
}

/** Почему аккаунт не должен получать доступ на узле. */
export function nodeBlockReason(user: UserRow, now = Date.now()): "" | "expired" | "quota" | "status" {
  const status = String(user.status ?? "").toLowerCase();
  if (status !== "active" && status !== "trial") return "status";

  const expires = user.expires_at ? Date.parse(String(user.expires_at).replace(" ", "T") + "Z") : 0;
  if (!expires || expires < now) return "expired";

  const quota = Number(user.traffic_gb ?? 0) + Number(user.traffic_extra_gb ?? 0);
  if (quota > 0) {
    const usedGb = Number(user.traffic_used_mb ?? 0) / 1024;
    // Запас в 1% — чтобы счётчик не отключал человека на ровном месте.
    if (usedGb >= quota * 0.999) return "quota";
  }
  return "";
}

/**
 * GET /api/node/clients — список ключей для синхронизации узла.
 *
 * Узел забирает его раз в пару минут и переписывает `clients` в конфиге
 * Xray. Так заблокированный аккаунт теряет доступ на самом сервере, а не
 * только в выдаче подписки, — клиент с сохранённым профилем тоже отвалится.
 */
export async function handleNodeClients(env: Env, request: Request): Promise<Response> {
  if (!(await checkTokenOk(env, request))) {
    return new Response("forbidden", { status: 403 });
  }

  const node = ownNode(env);
  if (!node) {
    return Response.json({ ok: false, error: "node_not_configured" }, { status: 409 });
  }

  let users: UserRow[] = [];
  try {
    users = await many<UserRow>(
      env,
      `SELECT id, tg_id, status, tier, sub_token, expires_at, device_limit,
              traffic_gb, traffic_extra_gb, traffic_used_mb
         FROM users
        WHERE sub_token IS NOT NULL AND sub_token != ''
        ORDER BY id LIMIT 1000`,
    );
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const now = Date.now();
  const clients: Array<{ email: string; uuid: string }> = [];
  const blocked: Array<{ email: string; reason: string }> = [];

  for (const user of users) {
    const reason = nodeBlockReason(user, now);
    if (reason) {
      blocked.push({ email: user.sub_token, reason });
      continue;
    }
    clients.push({
      email: user.sub_token,
      uuid: await uuidForToken(user.sub_token, envStr(env.SALT)),
    });
  }

  return Response.json(
    { ok: true, node: node.name, host: node.host, clients, blocked },
    { headers: { "cache-control": "no-store" } },
  );
}
