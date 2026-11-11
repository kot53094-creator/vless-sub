/**
 * Публичный read-only API v1.
 *
 * Что здесь есть и чего принципиально нет:
 *  • только опубликованные VLESS + REALITY серверы из shareable-источников;
 *  • ни одной ссылки, UUID, pbk, хоста или порта — иначе API превращается
 *    в бесплатный скрейпинг чужих конфигураций;
 *  • источники отдаются без URL (в URL лежит ключ подписки);
 *  • лимит частоты в памяти изолята: дешёвый и без записей в KV.
 *
 * Формат ошибок единый: { "error": { "code": "...", "message": "..." } }.
 */

import { many, one } from "./db";
import { clientIp, memRateLimit } from "./security";
import { isModern } from "./ranking";
import { classifyReality } from "./intake";
import type { Env } from "./types";

const VERSION = "1.0.0";

interface ApiServerRow {
  id: number;
  remark: string;
  link: string;
  host: string;
  port: number;
  status: string;
  latency_ms: number | null;
  last_check_at: string | null;
  verified_at: string | null;
  verified_latency_ms: number | null;
  country_name: string | null;
  city: string | null;
  country_code: string | null;
  enabled: number;
  priority: number;
  visibility: string;
  source_kind: string;
  pool_name: string | null;
}

/** Поля, которые можно показывать снаружи. Всё остальное отбрасываем. */
export interface PublicServer {
  id: number;
  name: string;
  country: string | null;
  city: string | null;
  country_code: string | null;
  /** Задержка настоящей проверки через туннель. null — туннель не проверяли. */
  latency_ms: number | null;
  /** Задержка TCP-коннекта к порту: справочно, к работе VPN не относится. */
  port_latency_ms: number | null;
  status: string;
  last_check_at: string | null;
  verified_at: string | null;
  protocol: "vless";
  reality: true;
  pool: string | null;
  checked: boolean;
}

/**
 * Одна и та же проверка для SQL-выборки и для уже загруженной строки:
 * публикуем только то, что реально уйдёт в подписку.
 */
export function isPublishable(server: {
  status?: string;
  enabled?: number | null;
  visibility?: string;
  source_kind?: string;
  link?: string;
}): boolean {
  if (server.enabled === 0) return false;
  if (server.status !== "alive" && server.status !== "unknown") return false;
  if (server.visibility !== "shareable") return false;
  if (server.source_kind === "paid_private") return false;
  const link = server.link ?? "";
  if (!isModern({ link })) return false;
  if (classifyReality(link) !== null) return false;
  return true;
}

/** Белый список полей: ссылка и хост не покидают Worker. */
export function toPublicServer(row: ApiServerRow): PublicServer {
  return {
    id: row.id,
    name: row.remark || `Сервер #${row.id}`,
    country: row.country_name,
    city: row.city,
    country_code: row.country_code,
    latency_ms: row.verified_latency_ms,
    port_latency_ms: row.latency_ms,
    status: row.status,
    last_check_at: row.last_check_at,
    verified_at: row.verified_at,
    protocol: "vless",
    reality: true,
    pool: row.pool_name,
    checked: Boolean(row.last_check_at),
  };
}

const SERVER_SQL = `
  SELECT s.id, s.remark, s.link, s.host, s.port, s.status, s.latency_ms,
         s.last_check_at, s.verified_at, s.verified_latency_ms,
         s.country_name, s.city, s.country_code,
         s.enabled, s.priority, src.visibility, src.kind AS source_kind,
         (SELECT p.name FROM pool_servers ps
            JOIN pools p ON p.id = ps.pool_id
           WHERE ps.server_id = s.id ORDER BY p.id LIMIT 1) AS pool_name
    FROM servers s
    JOIN sources src ON src.id = s.source_id
   WHERE s.enabled = 1
     AND s.status IN ('alive', 'unknown')
     AND src.visibility = 'shareable'
     AND src.kind <> 'paid_private'
   ORDER BY (s.status = 'alive') DESC, s.priority DESC,
            (s.verified_at IS NOT NULL) DESC, s.verified_latency_ms, s.id
   LIMIT ? OFFSET ?`;

function json(data: unknown, status = 200, cache = 30): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${cache}` : "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "x-api-version": VERSION,
    },
  });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status, 0);
}

/** Кэш в KV: отдаёт готовое тело без запросов к D1. */
async function withCache(
  env: Env,
  key: string,
  ttl: number,
  produce: () => Promise<Response>,
): Promise<Response> {
  const hit = await env.CACHE.get(key);
  if (hit !== null) {
    return new Response(hit, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttl}`,
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
        "x-api-version": VERSION,
        "x-cache": "hit",
      },
    });
  }

  try {
    const response = await produce();
    if (response.status === 200) {
      const body = await response.clone().text();
      await env.CACHE.put(key, body, { expirationTtl: ttl });
    }
    return response;
  } catch (error) {
    // Лимит D1 или сбой базы: отдаём честный 503, а не 1101.
    const message = error instanceof Error ? error.message : String(error);
    console.error("api v1 failed", message.slice(0, 200));
    return fail(
      "db_unavailable",
      "База временно недоступна: лимит D1 или сбой. Повторите позже.",
      503,
    );
  }
}

export async function handleApiV1(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fail("method_not_allowed", "Только GET", 405);
  }
  const ip = clientIp(request);
  if (!memRateLimit(`api1:${ip}`, 60, 60)) {
    return fail("rate_limited", "Слишком много запросов: 60 в минуту", 429);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/v1" || path === "/api/v1/") {
    return json({
      name: "Orange Frankenstein API",
      version: VERSION,
      endpoints: ["/api/v1/status", "/api/v1/stats", "/api/v1/sources", "/api/v1/servers", "/api/v1/openapi.json"],
      docs: `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/v1/openapi.json`,
    });
  }

  if (path === "/api/v1/openapi.json") {
    return json(openapi(env.PUBLIC_BASE_URL.replace(/\/+$/, "")), 200, 3600);
  }

  // Бесплатный D1 считает строки чтения, а не запросы. Публичные страницы
  // кэшируются в KV, иначе один мониторинг выедает суточный лимит.
  if (path === "/api/v1/status") {
    return await withCache(env, "api1:status", 300, () => statusEndpoint(env));
  }

  if (path === "/api/v1/stats") {
    return await withCache(env, "api1:stats", 600, () => statsEndpoint(env));
  }

  if (path === "/api/v1/sources") {
    return await withCache(env, "api1:sources", 900, () => sourcesEndpoint(env));
  }

  if (path === "/api/v1/servers") {
    const key = `api1:servers:${url.search}`;
    return await withCache(env, key, 300, () => serversEndpoint(env, url));
  }

  return fail("not_found", "Неизвестный эндпоинт", 404);
}

async function statusEndpoint(env: Env): Promise<Response> {
  const started = Date.now();
  let dbOk = true;
  try {
    await one<{ ok: number }>(env, "SELECT 1 AS ok");
  } catch {
    dbOk = false;
  }

  const counts = await one<{
    servers: number;
    alive: number;
    sources: number;
    dead_sources: number;
  }>(
    env,
    `SELECT (SELECT COUNT(*) FROM servers) AS servers,
            (SELECT COUNT(*) FROM servers WHERE status = 'alive') AS alive,
            (SELECT COUNT(*) FROM sources) AS sources,
            (SELECT COUNT(*) FROM sources WHERE status = 'dead') AS dead_sources`,
  );

  const last = await one<{ sync_at: string | null; check_at: string | null }>(
    env,
    `SELECT (SELECT MAX(last_sync_at) FROM sources) AS sync_at,
            (SELECT MAX(last_check_at) FROM servers) AS check_at`,
  );

  // Два разных типа проверок: порт и настоящий туннель. Смешивать нельзя —
  // открытый порт не означает рабочий VPN.
  const checks = await one<{
    tcp_ok: number;
    tcp_fail: number;
    tunnel_ok: number;
    tunnel_fail: number;
  }>(
    env,
    `SELECT COALESCE(SUM(kind = 'tcp'    AND result = 'ok'), 0)   AS tcp_ok,
            COALESCE(SUM(kind = 'tcp'    AND result = 'fail'), 0) AS tcp_fail,
            COALESCE(SUM(kind = 'tunnel' AND result = 'ok'), 0)   AS tunnel_ok,
            COALESCE(SUM(kind = 'tunnel' AND result = 'fail'), 0) AS tunnel_fail
       FROM server_checks
      WHERE checked_at >= datetime('now', '-1 day')`,
  );

  return json({
    ok: dbOk,
    version: VERSION,
    time: new Date().toISOString(),
    db: { ok: dbOk, latency_ms: Date.now() - started },
    counts: {
      servers: counts?.servers ?? 0,
      alive: counts?.alive ?? 0,
      sources: counts?.sources ?? 0,
      dead_sources: counts?.dead_sources ?? 0,
    },
    last: { sync_at: last?.sync_at ?? null, check_at: last?.check_at ?? null },
    checks_24h: {
      tunnel: { ok: checks?.tunnel_ok ?? 0, fail: checks?.tunnel_fail ?? 0 },
      port: { ok: checks?.tcp_ok ?? 0, fail: checks?.tcp_fail ?? 0 },
    },
  }, dbOk ? 200 : 503, 10);
}

/** Статистика считается по выборке: 2000 строк хватает с запасом. */
const STATS_SCAN_LIMIT = 2000;

async function statsEndpoint(env: Env): Promise<Response> {
  const rows = await many<ApiServerRow>(env, SERVER_SQL, STATS_SCAN_LIMIT, 0);
  const published = rows.filter(isPublishable);

  const byCountry = new Map<string, { code: string; name: string; count: number }>();
  let withLatency = 0;
  let latencySum = 0;
  let checked = 0;

  for (const row of published) {
    const code = (row.country_code ?? "??").toUpperCase();
    const entry = byCountry.get(code) ?? {
      code,
      name: row.country_name ?? "Неизвестно",
      count: 0,
    };
    entry.count += 1;
    byCountry.set(code, entry);
    if (row.verified_latency_ms && row.verified_latency_ms > 0) {
      withLatency += 1;
      latencySum += row.verified_latency_ms;
    }
    if (row.verified_at) checked += 1;
  }

  const users = await one<{ active: number }>(
    env,
    "SELECT COUNT(*) AS active FROM users WHERE status = 'active'",
  );

  // Отдельно: сколько узлов реально проверено через туннель за сутки.
  const tunnel = await one<{ ok: number; fail: number; tested: number }>(
    env,
    `SELECT COALESCE(SUM(result = 'ok'), 0) AS ok,
            COALESCE(SUM(result = 'fail'), 0) AS fail,
            COUNT(DISTINCT server_id) AS tested
       FROM server_checks
      WHERE kind = 'tunnel' AND checked_at >= datetime('now', '-1 day')`,
  );

  const importRow = await one<{ runs: number; parsed: number; publishable: number }>(
    env,
    `SELECT COUNT(*) AS runs, COALESCE(SUM(parsed), 0) AS parsed,
            COALESCE(SUM(publishable), 0) AS publishable
       FROM import_runs WHERE ran_at >= datetime('now', '-1 day')`,
  );

  return json({
    version: VERSION,
    // Границы расчёта: total честно считается только в пределах выборки.
    scan: { limit: STATS_SCAN_LIMIT, truncated: rows.length >= STATS_SCAN_LIMIT },
    published: {
      total: published.length,
      // tested = туннель проверяли (любой результат); working = последняя
      // проверка успешна. Это разные вещи, и путать их нельзя.
      tested: checked,
      // working = последняя туннельная проверка прошла. Статус от TCP-проверки
      // сюда не подмешивается: открытый порт не означает рабочий VPN.
      working: published.filter((server) => server.verified_latency_ms !== null).length,
      with_latency: withLatency,
      avg_latency_ms: withLatency ? Math.round(latencySum / withLatency) : null,
    },
    tunnel_24h: {
      ok: tunnel?.ok ?? 0,
      fail: tunnel?.fail ?? 0,
      servers_tested: tunnel?.tested ?? 0,
    },
    countries: [...byCountry.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    users_active: users?.active ?? 0,
    import_24h: {
      runs: importRow?.runs ?? 0,
      parsed: importRow?.parsed ?? 0,
      publishable: importRow?.publishable ?? 0,
    },
  });
}

async function sourcesEndpoint(env: Env): Promise<Response> {
  const rows = await many<{
    id: number;
    name: string;
    kind: string;
    status: string;
    last_sync_at: string | null;
    last_error: string;
    servers: number;
  }>(
    env,
    `SELECT s.id, s.name, s.kind, s.status, s.last_sync_at, s.last_error,
            (SELECT COUNT(*) FROM servers srv WHERE srv.source_id = s.id) AS servers
       FROM sources s ORDER BY s.id`,
  );

  // URL источника не отдаём никогда: в нём лежит ключ подписки.
  return json({
    version: VERSION,
    sources: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      last_sync_at: row.last_sync_at,
      servers: row.servers,
      error: row.last_error ? row.last_error.slice(0, 80) : null,
    })),
  });
}

async function serversEndpoint(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const country = (url.searchParams.get("country") ?? "").toUpperCase();
  const maxLatency = Number(url.searchParams.get("max_latency") ?? 0) || 0;

  // Берём с запасом: часть строк отсеется фильтром публикации.
  const rows = await many<ApiServerRow>(env, SERVER_SQL, Math.min(500, limit * 4 + 40), offset);
  let servers = rows.filter(isPublishable).map(toPublicServer);

  if (country) servers = servers.filter((server) => server.country_code === country);
  if (maxLatency > 0) {
    servers = servers.filter((server) => (server.latency_ms ?? 1e9) <= maxLatency);
  }

  const page = servers.slice(0, limit);
  return json({
    version: VERSION,
    count: page.length,
    next_offset: page.length === limit ? offset + limit : null,
    servers: page,
  });
}

/** OpenAPI 3.1: минимально достаточное описание того, что реально работает. */
export function openapi(baseUrl: string): Record<string, unknown> {
  const server = {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      country: { type: ["string", "null"] },
      city: { type: ["string", "null"] },
      country_code: { type: ["string", "null"] },
      latency_ms: { type: ["integer", "null"] },
      status: { type: "string", enum: ["alive", "unknown"] },
      last_check_at: { type: ["string", "null"] },
      protocol: { type: "string", enum: ["vless"] },
      reality: { type: "boolean" },
      pool: { type: ["string", "null"] },
      checked: { type: "boolean" },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Orange Frankenstein API",
      version: VERSION,
      description:
        "Публичный read-only API агрегатора VLESS + REALITY. Ссылки, UUID и адреса серверов не выдаются.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/api/v1/status": {
        get: {
          summary: "Состояние сервиса",
          responses: { "200": { description: "OK" }, "503": { description: "База недоступна" } },
        },
      },
      "/api/v1/stats": {
        get: { summary: "Сводная статистика", responses: { "200": { description: "OK" } } },
      },
      "/api/v1/sources": {
        get: { summary: "Источники без URL", responses: { "200": { description: "OK" } } },
      },
      "/api/v1/servers": {
        get: {
          summary: "Опубликованные серверы",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", maximum: 100, default: 30 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
            { name: "country", in: "query", schema: { type: "string" }, description: "Код страны, например NL" },
            { name: "max_latency", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "Список",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      count: { type: "integer" },
                      next_offset: { type: ["integer", "null"] },
                      servers: { type: "array", items: server },
                    },
                  },
                },
              },
            },
            "429": { description: "Лимит частоты" },
          },
        },
      },
    },
    components: {
      schemas: { Server: server },
      responses: {
        Error: {
          description: "Ошибка",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "object",
                    properties: { code: { type: "string" }, message: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
