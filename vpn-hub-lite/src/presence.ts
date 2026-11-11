/**
 * Присутствие: включён ли у человека VPN прямо сейчас.
 *
 * Чего здесь нет и не будет: «магии». Worker не стоит между клиентом и узлом,
 * поэтому расход трафика и факт подключения ему не видны. Видно только одно —
 * запрос подписки и его IP.
 *
 * Отсюда правило:
 *   • запрос пришёл с IP, который является выходом нашего узла  → туннель шёл;
 *   • запрос пришёл с любого другого IP                          → туннеля не было.
 *
 * Второе честнее читать как «в этот момент не через нас», а не «человек точно
 * выключил VPN»: клиент мог качать подписку мимо туннеля по правилам обхода.
 */

import { many, run } from "./db";
import { clientIp, envStr, hashValue } from "./security";
import type { Env } from "./types";

const EXIT_KEY = "presence:exitmap:v1";
/** Карта выходных IP меняется медленно: держим её в KV, чтобы не читать D1. */
const EXIT_TTL = 600;
/** Молчание дольше этого срока — уже не «сейчас», а «последний раз». */
export const FRESH_SECONDS = 300;
/** Не чаще раза в ~2 минуты на человека: запись в D1 не бесплатная. */
const WRITE_GAP = 110;

export interface ExitNode {
  id: number;
  host: string;
  country: string;
  code: string;
}

export type ExitMap = Record<string, ExitNode>;

/** Карта «выходной IP → узел». Строится по серверам, где проверка узнала exit_ip. */
export async function exitMap(env: Env): Promise<ExitMap> {
  const cached = await env.CACHE.get<ExitMap>(EXIT_KEY, "json");
  if (cached) return cached;

  const rows = await many<{
    id: number;
    host: string;
    exit_ip: string;
    country_code: string | null;
    country_name: string | null;
  }>(
    env,
    `SELECT id, host, exit_ip, country_code, country_name FROM servers
      WHERE enabled = 1 AND exit_ip IS NOT NULL AND exit_ip <> ''`,
  );

  const map: ExitMap = {};
  for (const row of rows) {
    const ip = row.exit_ip.trim();
    if (!ip) continue;
    map[ip] = {
      id: row.id,
      host: row.host,
      country: (row.country_code ?? row.country_name ?? "").toUpperCase(),
      code: (row.country_code ?? "").toUpperCase(),
    };
  }
  await env.CACHE.put(EXIT_KEY, JSON.stringify(map), { expirationTtl: EXIT_TTL });
  return map;
}

/** Агент узнал новые выходные IP — старую карту выбрасываем. */
export async function invalidateExitMap(env: Env): Promise<void> {
  try {
    await env.CACHE.delete(EXIT_KEY);
  } catch {
    /* кэш не критичен: через 10 минут пересоберётся сам */
  }
}

export interface Snapshot {
  state: "on" | "off";
  ip: string;
  node: ExitNode | null;
}

/** Снимок «через что пришёл этот запрос». */
export async function snapshot(env: Env, request: Request): Promise<Snapshot> {
  const ip = clientIp(request);
  if (!ip || ip === "unknown") return { state: "off", ip: "", node: null };

  let map: ExitMap = {};
  try {
    map = await exitMap(env);
  } catch {
    // Без карты честнее сказать «не знаем», но состояние у нас бинарное —
    // пишем off и не портим подписку.
    map = {};
  }
  const node = map[ip] ?? null;
  return { state: node ? "on" : "off", ip, node };
}

/**
 * Запись состояния. Одна UPSERT-команда без предварительного чтения:
 * лишние чтения D1 — то, из-за чего проект уже ловил отказ по квоте.
 */
export async function recordPresence(
  env: Env,
  userId: number,
  snap: Snapshot,
  source: "sub" | "probe",
): Promise<void> {
  try {
    const ipHash = snap.ip ? await hashValue(snap.ip, envStr(env.SALT)) : "";
    await run(
      env,
      `INSERT INTO user_presence
         (user_id, state, ip_hash, via_host, via_country, via_server, source, last_seen, last_on_at, last_off_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'),
               CASE WHEN ? = 'on' THEN datetime('now') END,
               CASE WHEN ? = 'off' THEN datetime('now') END)
       ON CONFLICT (user_id) DO UPDATE SET
         state       = excluded.state,
         ip_hash     = excluded.ip_hash,
         via_host    = excluded.via_host,
         via_country = excluded.via_country,
         via_server  = excluded.via_server,
         source      = excluded.source,
         last_seen   = excluded.last_seen,
         last_on_at  = COALESCE(CASE WHEN excluded.state = 'on'  THEN excluded.last_seen END, user_presence.last_on_at),
         last_off_at = COALESCE(CASE WHEN excluded.state = 'off' THEN excluded.last_seen END, user_presence.last_off_at)
       WHERE user_presence.state <> excluded.state
          OR user_presence.source <> excluded.source
          OR user_presence.last_seen < datetime('now', '-${WRITE_GAP} seconds')`,
      userId,
      snap.state,
      ipHash,
      snap.node?.host ?? "",
      snap.node?.country ?? "",
      snap.node?.id ?? null,
      source,
      snap.state,
      snap.state,
    );
  } catch (error) {
    // Подписка важнее телеметрии: её сбой не должен ломать выдачу ключей.
    console.error("presence failed", error instanceof Error ? error.message : error);
  }
}

export interface LiveRow {
  user_id: number;
  tg_id: string;
  tg_username: string;
  status: string;
  state: "on" | "off";
  via_host: string;
  via_country: string;
  source: string;
  last_seen: string;
  age: number;
}

/** Все, кого мы когда-либо видели, со свежестью снимка в секундах. */
export async function liveRows(env: Env): Promise<LiveRow[]> {
  return await many<LiveRow>(
    env,
    `SELECT p.user_id, u.tg_id, u.tg_username, u.status,
            p.state, p.via_host, p.via_country, p.source, p.last_seen,
            CAST((julianday('now') - julianday(p.last_seen)) * 86400 AS INTEGER) AS age
       FROM user_presence p
       JOIN users u ON u.id = p.user_id
      ORDER BY p.last_seen DESC
      LIMIT 200`,
  );
}

/** «12 сек», «4 мин», «3 ч», «2 дн». */
export function humanAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} сек`;
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч`;
  return `${Math.floor(s / 86400)} дн`;
}
