/**
 * Геолокация серверов по IP.
 *
 * Нужна только для человекочитаемых имён («VLESS · Германия»). Данные берём
 * у ip-api.com пакетами до 100 адресов: один подзапрос на пачку.
 *
 * Обновления пишем одним batch(): лимит бесплатного плана — 50 запросов
 * к D1 за вызов, поштучные UPDATE его быстро выбивают.
 *
 * Если сервис недоступен — страна остаётся пустой, имя будет
 * «VLESS · Регион неизвестен». Это честнее, чем угадывать по названию.
 */

import { logEvent, many } from "./db";
import type { Env } from "./types";

const ENDPOINT = "http://ip-api.com/batch?fields=status,country,countryCode,city,query";
const MAX_PER_RUN = 40;

interface GeoRow {
  status: string;
  country?: string;
  countryCode?: string;
  city?: string;
  query: string;
}

function isIpv4(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

/** Дозаполняет страну у серверов, где её ещё нет. Возвращает число обновлённых. */
export async function fillGeo(env: Env, limit = MAX_PER_RUN): Promise<number> {
  const limitValue = Math.max(1, Math.min(MAX_PER_RUN, limit));

  const rows = await many<{ id: number; host: string; country_code: string | null }>(
    env,
    `SELECT id, host, country_code FROM servers
      WHERE country_code IS NULL AND host <> ''
      ORDER BY (status = 'alive') DESC, id
      LIMIT ?`,
    limitValue,
  );
  if (!rows.length) return 0;

  const targets = rows.filter((row) => isIpv4(row.host));

  // Домены сюда не попадают: ip-api работает только с IP. Помечаем их
  // пустой строкой, чтобы не выбирать заново каждый прогон.
  const skipped = rows.filter((row) => !isIpv4(row.host));
  if (skipped.length) {
    await env.DB.batch(
      skipped.map((row) =>
        env.DB.prepare("UPDATE servers SET country_code = '' WHERE id = ?").bind(row.id),
      ),
    );
  }

  if (!targets.length) return 0;

  let data: GeoRow[] = [];
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(targets.map((row) => row.host)),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`geo http ${response.status}`);
    const parsed = (await response.json()) as unknown;
    if (Array.isArray(parsed)) data = parsed as GeoRow[];
  } catch (error) {
    console.error("geo failed", error instanceof Error ? error.message : error);
    return 0;
  }

  const byHost = new Map<string, GeoRow>();
  for (const item of data) {
    if (item && typeof item.query === "string") byHost.set(item.query, item);
  }

  const statements: D1PreparedStatement[] = [];
  let updated = 0;

  for (const server of targets) {
    const item = byHost.get(server.host);
    if (!item) continue;
    if (item.status !== "success" || !item.countryCode) {
      statements.push(
        env.DB.prepare("UPDATE servers SET country_code = '' WHERE id = ?").bind(server.id),
      );
      continue;
    }
    statements.push(
      env.DB.prepare(
        "UPDATE servers SET country_code = ?, country_name = ?, city = ? WHERE id = ?",
      ).bind(item.countryCode, item.country ?? "", item.city ?? "", server.id),
    );
    updated += 1;
  }

  if (statements.length) await env.DB.batch(statements);
  if (updated) await logEvent(env, "geo", null, `определено стран: ${updated}`);

  return updated;
}
