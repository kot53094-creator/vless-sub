/**
 * Персональная подписка /sub/<token>.
 *
 * Особенности:
 *  • отдаём только живые серверы из shareable-источников;
 *  • paid_private и visibility=private не попадают сюда никогда;
 *  • ответ кэшируется в KV на SUB_CACHE_TTL секунд;
 *  • fetch_log пишется не чаще раза в час на пользователя.
 */

import { many, one, run, logEvent } from "./db";
import { buildSubscription, parseUri, withLabel } from "./parser";
import { serverLabel } from "./labels";
import {
  clientIp,
  hashValue,
  memRateLimit,
  randomToken,
  envStr,
  timingSafeEqual,
} from "./security";
import type { DeliverableServer, Env, UserRow } from "./types";
import { BRAND } from "./brand";
import { assignIfEmpty } from "./balance";
import { compareServers, isModern } from "./ranking";

export const PROFILE_REFRESH_HOURS = 6;

const SERVER_SQL = `
  SELECT s.id, s.source_id, s.remark, s.link, s.host, s.port, s.status,
         s.latency_ms, s.last_check_at, s.max_users, s.seen_at,
          s.country_name, s.city, s.country_code, s.tier, s.enabled,
          src.visibility, src.kind AS source_kind,
         (SELECT p.name FROM pool_servers ps
            JOIN pools p ON p.id = ps.pool_id
           WHERE ps.server_id = s.id ORDER BY p.id LIMIT 1) AS pool_name
  FROM assignments a
  JOIN servers s ON s.id = a.server_id
  JOIN sources src ON src.id = s.source_id
  WHERE a.user_id = ?1 AND s.status IN ('alive', 'unknown')
    AND (src.visibility = 'shareable' OR ?2 = 1)
    AND (src.kind <> 'paid_private' OR ?2 = 1)
    AND (
      src.max_devices = 0
      OR EXISTS (SELECT 1 FROM user_sources us
                  WHERE us.user_id = a.user_id AND us.source_id = src.id)
    )
  -- Лучшие сверху: сначала проверенные живые, потом по задержке.
  ORDER BY (s.status = 'alive') DESC, (s.latency_ms IS NULL), s.latency_ms, s.id
`;

/** Защита в глубину: даже если SQL что-то пропустит, приватное не уйдёт. */
export function isDeliverable(
  server: {
    visibility?: string;
    source_kind?: string;
    status?: string;
  },
  allowPrivate = false,
): boolean {
  if (server.status && server.status !== "alive" && server.status !== "unknown") return false;
  // Приватные и оплаченные источники не уходят никому, кроме владельца:
  // для него allowPrivate=true, для остальных — жёсткий отсев.
  if (!allowPrivate) {
    if (server.visibility !== "shareable") return false;
    if (server.source_kind === "paid_private") return false;
  }
  return true;
}

function stubBody(reason: string): string {
  const remark = encodeURIComponent(reason);
  const fake =
    `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:1` +
    `?encryption=none&security=none&type=tcp#${remark}`;
  return buildSubscription([fake]);
}

function timedOutStatus(user: UserRow | null): string | null {
  if (!user) return "Подписка не найдена — напишите боту /start";
  if (user.status === "banned") return "Доступ закрыт — напишите админу";
  if (user.status === "pending") return "Заявка ещё не одобрена — подождите";
  if (user.status === "expired") return "Срок истёк — напишите боту";
  if (user.expires_at) {
    const ts = Date.parse(user.expires_at.replace(" ", "T") + "Z");
    if (Number.isFinite(ts) && ts < Date.now()) return "Срок истёк — напишите боту";
  }
  return null;
}

function expireTs(user: UserRow): number {
  if (!user.expires_at) return 0;
  const ts = Date.parse(user.expires_at.replace(" ", "T") + "Z");
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : 0;
}

export async function handleSubscription(
  env: Env,
  token: string,
  request: Request,
): Promise<Response> {
  const ip = clientIp(request);
  // 60 запросов в минуту с одного адреса — защита от перебора токенов
  if (!memRateLimit(`sub:${ip}`, 60, 60)) {
    return new Response("Слишком много запросов", { status: 429 });
  }
  if (!token || token.length < 20) {
    return new Response("Не найдено", { status: 404 });
  }

  const user = await one<UserRow>(
    env,
    "SELECT * FROM users WHERE sub_token = ?",
    token,
  );
  // сравнение за постоянное время уже после выборки
  if (!user || !timingSafeEqual(user.sub_token, token)) {
    return plain(stubBody("Подписка не найдена — напишите боту"), null, null);
  }

  const blocked = timedOutStatus(user);
  if (blocked) {
    return plain(stubBody(blocked), null, user);
  }

  // Устройство могли отвязать вручную — тогда именно ему отдаём отказ.
  const device = await touchDevice(env, user.id, request.headers.get("User-Agent") ?? "");
  if (device?.blocked) {
    return plain(
      stubBody("Это устройство отключено. Откройте бота → «📱 Устройства»"),
      null,
      user,
    );
  }

  const cacheKey = `sub:v2:${token}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as { body: string };
    // Заголовок считаем заново из БД: в кэше он устаревает и Happ
    // показывает «безлимит», если срок или лимит поменяли.
    return plain(parsed.body, await buildUserinfo(env, user), user);
  }

  // Платные и приватные источники видит только админ — «моя подписка».
  const isAdmin = String(user.tg_id) === envStr(env.ADMIN_TG_ID);
  let rows = await many<DeliverableServer>(env, SERVER_SQL, user.id, isAdmin ? 1 : 0);
  let deliverable = rows.filter((row) => isDeliverable(row, isAdmin));

  // Самовосстановление: серверы есть, а человеку ничего не выдано — выдаём сейчас.
  if (deliverable.length === 0) {
    const issued = await assignIfEmpty(env, user.id, Number(env.SERVERS_PER_USER ?? "3"));
    if (issued > 0) {
      rows = await many<DeliverableServer>(env, SERVER_SQL, user.id, isAdmin ? 1 : 0);
      deliverable = rows.filter((row) => isDeliverable(row, isAdmin));
    }
  }

  // Только то, что реально пробивает блокировки, и лучшее — вверх.
  // Тарифные категории: personal — только владельцу, free/premium — по тарифу.
  const userTier = isAdmin ? "personal" : (user.tier ?? "free");
  deliverable = deliverable
    .filter((server) => server.enabled !== 0)
    .filter((server) => {
      const tier = server.tier ?? "free";
      if (tier === "personal") return isAdmin;
      if (userTier === "premium") return true;
      return tier === "free";
    })
    .filter(isModern)
    .sort(compareServers);

  const uris: string[] = [];
  deliverable.forEach((server, index) => {
    const key = parseUri(server.link);
    if (!key) return;
    const own = server.visibility === "private" ? server.remark : "";
    uris.push(
      withLabel(
        server.link,
        serverLabel(server.pool_name, key, index + 1, own, {
          country: server.country_name,
          city: server.city,
          code: server.country_code,
        }),
      ),
    );
  });

  const body =
    uris.length > 0
      ? buildSubscription(uris)
      : stubBody("Серверы временно недоступны — напишите боту");

  const userinfo = await buildUserinfo(env, user);
  await touchFetchLog(env, user, request);

  if (uris.length > 0) {
    await env.CACHE.put(cacheKey, JSON.stringify({ body }), {
      expirationTtl: Number(env.SUB_CACHE_TTL ?? "600"),
    });
  }

  return plain(body, userinfo, user);
}

function plain(body: string, userinfo: string | null, user: UserRow | null): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "profile-title": BRAND,
    "profile-update-interval": String(PROFILE_REFRESH_HOURS),
    "cache-control": "no-store",
  };
  // Заголовок нужен всегда: по нему клиент понимает срок и трафик.
  headers["subscription-userinfo"] =
    userinfo ?? "upload=0; download=0; total=0; expire=0";
  return new Response(body, { status: 200, headers });
}

/** Лимит и срок конкретного человека — их и показывает Happ. */
async function buildUserinfo(env: Env, user: UserRow): Promise<string> {
  const total = Math.max(0, Number(user.traffic_gb ?? 0)) * 1024 ** 3;
  const used = 0; // реальный расход у провайдера, воркер его не видит
  return `upload=0; download=${used}; total=${total}; expire=${expireTs(user)}`;
}

/** Не чаще одного раза в час: экономит записи D1. */
async function touchFetchLog(env: Env, user: UserRow, request: Request): Promise<void> {
  const last = user.last_fetch_at
    ? Date.parse(user.last_fetch_at.replace(" ", "T") + "Z")
    : 0;
  if (Date.now() - last < 3600_000) return;

  const ipHash = await hashValue(clientIp(request), envStr(env.SALT));
  const uaHash = await hashValue(request.headers.get("User-Agent") ?? "-", envStr(env.SALT));
  const tsHour = new Date().toISOString().slice(0, 13);

  await run(
    env,
    "INSERT INTO fetch_log (user_id, ts_hour, ip_hash, ua_hash) VALUES (?, ?, ?, ?)",
    user.id,
    tsHour,
    ipHash,
    uaHash,
  );
  await run(env, "UPDATE users SET last_fetch_at = datetime('now') WHERE id = ?", user.id);

  const devices = await devices24h(env, user.id);
  if (devices > user.device_limit) {
    await logEvent(env, "device_limit", user.id, `устройств за 24 ч: ${devices}`);
  }
}

export interface UserDevice {
  id: number;
  label: string;
  last_seen: string;
  blocked: number;
}

/** «iPhone · Happ», «Windows · Happ» — без сырого User-Agent. */
export function deviceLabel(ua: string): string {
  const app = /happ/i.test(ua)
    ? "Happ"
    : /streisand/i.test(ua)
      ? "Streisand"
      : /v2rayng/i.test(ua)
        ? "v2rayNG"
        : /hiddify/i.test(ua)
          ? "Hiddify"
          : /shadowrocket/i.test(ua)
            ? "Shadowrocket"
            : /foxray/i.test(ua)
              ? "FoXray"
              : /clash|mihomo/i.test(ua)
                ? "Clash"
                : "Клиент";

  const os = /ipad/i.test(ua)
    ? "iPad"
    : /iphone|ios/i.test(ua)
      ? "iPhone"
      : /android/i.test(ua)
        ? "Android"
        : /windows/i.test(ua)
          ? "Windows"
          : /macintosh|mac os/i.test(ua)
            ? "macOS"
            : /linux/i.test(ua)
              ? "Linux"
              : "Устройство";

  return `${os} · ${app}`;
}

/**
 * Регистрирует устройство при каждом запросе подписки и сообщает,
 * заблокировано ли оно. Ключ — хеш User-Agent с солью.
 */
export async function touchDevice(
  env: Env,
  userId: number,
  ua: string,
): Promise<{ blocked: boolean } | null> {
  if (!ua || ua === "-") return null;
  const key = await hashValue(ua, envStr(env.SALT));

  await run(
    env,
    `INSERT INTO user_devices (user_id, device_key, label) VALUES (?, ?, ?)
     ON CONFLICT (user_id, device_key)
     DO UPDATE SET last_seen = datetime('now'), label = excluded.label`,
    userId,
    key,
    deviceLabel(ua),
  );

  const row = await one<{ blocked: number }>(
    env,
    "SELECT blocked FROM user_devices WHERE user_id = ? AND device_key = ?",
    userId,
    key,
  );
  return { blocked: row?.blocked === 1 };
}

export async function listDevices(env: Env, userId: number): Promise<UserDevice[]> {
  return await many<UserDevice>(
    env,
    `SELECT id, label, last_seen, blocked FROM user_devices
      WHERE user_id = ? ORDER BY blocked ASC, last_seen DESC LIMIT 10`,
    userId,
  );
}

export async function setDeviceBlocked(
  env: Env,
  userId: number,
  id: number,
  blocked: boolean,
): Promise<boolean> {
  const result = await run(
    env,
    "UPDATE user_devices SET blocked = ? WHERE id = ? AND user_id = ?",
    blocked ? 1 : 0,
    id,
    userId,
  );
  return Boolean(result.meta.changes);
}

export async function devices24h(env: Env, userId: number): Promise<number> {
  const row = await one<{ n: number }>(
    env,
    `SELECT COUNT(DISTINCT ip_hash || ':' || ua_hash) AS n
     FROM fetch_log
     WHERE user_id = ? AND ts_hour >= strftime('%Y-%m-%dT%H', datetime('now', '-24 hours'))`,
    userId,
  );
  return row?.n ?? 0;
}

export async function rotateToken(env: Env, user: UserRow): Promise<string> {
  const token = randomToken(32);
  await run(env, "UPDATE users SET sub_token = ? WHERE id = ?", token, user.id);
  await env.CACHE.delete(`sub:v1:${user.sub_token}`);
  await logEvent(env, "newkey", user.id, "ссылка перевыпущена");
  return token;
}

export async function invalidateSubscription(env: Env, token: string): Promise<void> {
  // Чистим все версии ключа: иначе после смены формата остаётся старый кэш
  // и человек видит устаревшие имена серверов.
  await env.CACHE.delete(`sub:v1:${token}`);
  await env.CACHE.delete(`sub:v2:${token}`);
  await env.CACHE.delete(`sub:v3:${token}`);
}

