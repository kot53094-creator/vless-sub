/**
 * Cron «sync» — раз в 6 часов.
 *
 * Бюджет бесплатного плана: 10 мс CPU, 50 подзапросов, 6 соединений.
 * Поэтому за прогон обрабатываем 2 источника, качаем не больше 300 КБ,
 * разбираем не больше 120 ключей и пишем пачками.
 */

import { batch, logEvent, many, one, prepare, run } from "./db";
import { isSingleKey, parseSubscription, parseUri, parseUserinfo } from "./parser";
import type { Env, SourceRow } from "./types";

const SOURCES_PER_RUN = 2;
const MAX_KEYS = 120;
const MAX_BODY = 300_000;
const SOURCE_CACHE_TTL = 6 * 3600;

interface CachedSource {
  text: string;
  userinfo: ReturnType<typeof parseUserinfo>;
}

export interface SyncResult {
  sources: number;
  servers: number;
  errors: string[];
}

export async function runSync(env: Env): Promise<SyncResult> {
  const due = await many<SourceRow>(
    env,
    `SELECT * FROM sources
     WHERE url_or_link <> ''
       AND (last_sync_at IS NULL OR last_sync_at < datetime('now', '-6 hours'))
     ORDER BY last_sync_at IS NOT NULL, last_sync_at
     LIMIT ?`,
    SOURCES_PER_RUN,
  );

  const result: SyncResult = { sources: 0, servers: 0, errors: [] };

  for (const source of due) {
    try {
      const count = await syncOne(env, source);
      result.sources += 1;
      result.servers += count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${source.id}: ${message.slice(0, 120)}`);
      await run(
        env,
        `UPDATE sources
         SET last_sync_at = datetime('now'), last_error = ?
         WHERE id = ?`,
        message.slice(0, 200),
        source.id,
      );
    }
  }

  if (result.sources > 0) {
    await logEvent(
      env,
      "sync",
      null,
      `источников: ${result.sources}, серверов: ${result.servers}`,
    );
  }
  return result;
}

async function syncOne(env: Env, source: SourceRow): Promise<number> {
  // Ключи, добавленные руками через /addkey: и одна строка, и несколько.
  const isLink = /^https?:\/\//i.test(source.url_or_link.trim());
  if (!isLink && source.url_or_link.includes("://")) {
    const local = parseSubscription(source.url_or_link, MAX_KEYS);
    if (!local.length) throw new Error("в источнике нет валидных ключей");
    for (const key of local) {
      await upsertServer(env, source.id, key.uri, key.host, key.port, key.remark);
    }
    await run(
      env,
      `UPDATE sources SET status='alive', last_sync_at=datetime('now'), last_error=''
       WHERE id=?`,
      source.id,
    );
    await autoPool(env, source);
    return local.length;
  }

  const cached = await readCachedSource(env, source.id);
  let payload: CachedSource;

  if (cached) {
    payload = cached;
  } else {
    payload = await downloadSource(env, source);
    await env.CACHE.put(`src:${source.id}`, JSON.stringify(payload), {
      expirationTtl: SOURCE_CACHE_TTL,
    });
  }

  const info = payload.userinfo;
  const keys = parseSubscription(payload.text, MAX_KEYS);

  await run(
    env,
    `UPDATE sources SET
       status = ?, last_sync_at = datetime('now'), last_error = '',
       traffic_used = COALESCE(?, traffic_used),
       traffic_total = COALESCE(?, traffic_total),
       expires_at = COALESCE(?, expires_at)
     WHERE id = ?`,
    keys.length ? "alive" : "dead",
    info.download,
    info.total,
    info.expire ? new Date(info.expire * 1000).toISOString().slice(0, 19).replace("T", " ") : null,
    source.id,
  );

  if (!keys.length) return 0;

  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const statements = keys.map((key) =>
    prepare(
      env,
      `INSERT INTO servers (source_id, remark, link, host, port, status, seen_at, max_users)
       VALUES (?, ?, ?, ?, ?, 'alive', ?, 10)
       ON CONFLICT (source_id, host, port) DO UPDATE SET
         link = excluded.link,
         remark = excluded.remark,
         seen_at = excluded.seen_at,
         status = CASE WHEN servers.status = 'dead' THEN 'unknown' ELSE servers.status END`,
      source.id,
      key.remark.slice(0, 120),
      key.uri,
      key.host,
      key.port,
      stamp,
    ),
  );
  await batch(env, statements);

  // Серверы, которых больше нет в источнике, помечаем мёртвыми.
  await run(
    env,
    "UPDATE servers SET status='dead' WHERE source_id=? AND (seen_at IS NULL OR seen_at < ?)",
    source.id,
    stamp,
  );

  // Новые серверы сразу раскладываем по пулам по типу источника.
  await autoPool(env, source);

  return keys.length;
}

function defaultPoolName(kind: string): string {
  if (kind === "bridge_ru" || kind === "cdn_xhttp") return "Белые списки";
  if (kind === "trial" || kind === "paid_private") return "Азия";
  return "Европа";
}

async function autoPool(env: Env, source: SourceRow): Promise<void> {
  const pool = await one<{ id: number }>(
    env,
    "SELECT id FROM pools WHERE name = ?",
    defaultPoolName(source.kind),
  );
  if (!pool) return;
  await run(
    env,
    `INSERT OR IGNORE INTO pool_servers (pool_id, server_id)
     SELECT ?, s.id FROM servers s
     WHERE s.source_id = ?
       AND NOT EXISTS (SELECT 1 FROM pool_servers ps WHERE ps.server_id = s.id)`,
    pool.id,
    source.id,
  );
}

async function upsertServer(
  env: Env,
  sourceId: number,
  link: string,
  host: string,
  port: number,
  remark: string,
): Promise<void> {
  await run(
    env,
    `INSERT INTO servers (source_id, remark, link, host, port, status, seen_at, max_users)
     VALUES (?, ?, ?, ?, ?, 'alive', datetime('now'), 10)
     ON CONFLICT (source_id, host, port) DO UPDATE SET
       link = excluded.link, remark = excluded.remark,
       seen_at = excluded.seen_at,
       status = CASE WHEN servers.status = 'dead' THEN 'unknown' ELSE servers.status END`,
    sourceId,
    remark.slice(0, 120),
    link,
    host,
    port,
  );
}

async function readCachedSource(env: Env, id: number): Promise<CachedSource | null> {
  const raw = await env.CACHE.get(`src:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedSource;
  } catch {
    return null;
  }
}

async function downloadSource(env: Env, source: SourceRow): Promise<CachedSource> {
  const response = await fetch(source.url_or_link, {
    headers: {
      // Один фиксированный UA и один HWID на источник, как требует ТЗ.
      "User-Agent": env.FETCH_UA ?? "Happ/2.9.1",
      "x-hwid": `vh-${source.id}-${env.SALT.slice(0, 8)}`,
      Accept: "*/*",
    },
    signal: AbortSignal.timeout(10_000),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`источник ответил HTTP ${response.status}`);
  }
  const text = (await response.text()).slice(0, MAX_BODY);
  const userinfo = parseUserinfo(response.headers.get("subscription-userinfo"));
  return { text, userinfo };
}
