/**
 * Публичная страница состояния /status.
 *
 * Показывает только эксплуатационные цифры: доступность базы, когда
 * последний раз обновлялись источники и проверялись серверы, сколько
 * конфигураций реально опубликовано. Ни ссылок, ни токенов, ни ID людей.
 */

import { one } from "./db";
import { BRAND } from "./brand";
import type { Env } from "./types";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ago(value: string | null): string {
  if (!value) return "ещё не было";
  const ts = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (!Number.isFinite(ts)) return esc(value);
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

const CSS = `
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--text:#e8ecf3;--muted:#8b95a7;--orange:#ff8a3d}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(900px 420px at 20% -10%,#2a1a12 0%,transparent 60%),var(--bg);
color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:40px 20px 60px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px}
.brand i{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;
background:linear-gradient(140deg,var(--orange),#ff5f1f);color:#1a1207;font-style:normal;font-weight:800}
h1{font-size:28px;margin:22px 0 6px}
.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:22px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.card b{display:block;font-size:24px;line-height:1.2;margin-bottom:4px}
.card span{color:var(--muted);font-size:13px}
.state{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;
font-size:13px;font-weight:600;border:1px solid var(--line);background:#12151b}
.dot{width:8px;height:8px;border-radius:50%}
.ok .dot{background:#39d98a;box-shadow:0 0 0 4px rgba(57,217,138,.15)}
.bad .dot{background:#ff5f5f;box-shadow:0 0 0 4px rgba(255,95,95,.15)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:6px 16px;margin-top:14px}
.row{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px}
.row:last-child{border-bottom:0}
.row span:last-child{color:var(--muted);text-align:right}
a{color:var(--orange);text-decoration:none}
a:hover{text-decoration:underline}
footer{margin-top:26px;font-size:12px;color:var(--muted)}
@media (max-width:520px){h1{font-size:23px}.wrap{padding:24px 14px 40px}}
`;

export async function statusPage(env: Env): Promise<Response> {
  let dbOk = true;
  let counts = { servers: 0, alive: 0, sources: 0, published: 0 };
  let last = { sync_at: null as string | null, check_at: null as string | null };
  let checks = { tcpOk: 0, tcpFail: 0, tunnelOk: 0, tunnelFail: 0 };
  // Метрика сторожа пула: столько узлов реально прошли проверку трафиком
  // за 72 часа. Именно из них собирается подписка, поэтому цифра честнее
  // «серверов отвечают» — открытый порт VPN не гарантирует.
  let pool: { verified: number; threshold: number; ts: number } | null = null;

  // Страница публичная и её часто опрашивают мониторинги. Каждый заход —
  // это COUNT(*) по всей таблице servers и SUM по server_checks, то есть
  // тысячи прочитанных строк D1. Кэшируем агрегаты на минуту: цифры для
  // человека всё равно меняются не чаще проверок, а суточная квота D1
  // перестаёт расходоваться на внешние пинги.
  const cachedStats = await env.CACHE.get<{
    dbOk: boolean;
    counts: typeof counts;
    last: typeof last;
    checks: typeof checks;
  }>("status:counts:v1", "json").catch(() => null);
  if (cachedStats) {
    dbOk = cachedStats.dbOk;
    counts = cachedStats.counts;
    last = cachedStats.last;
    checks = cachedStats.checks;
  }

  if (!cachedStats) {
    try {
      const row = await one<{
        servers: number;
        alive: number;
        sources: number;
        published: number;
        sync_at: string | null;
        check_at: string | null;
      }>(
        env,
        `SELECT (SELECT COUNT(*) FROM servers) AS servers,
              (SELECT COUNT(*) FROM servers WHERE status='alive') AS alive,
              (SELECT COUNT(*) FROM sources) AS sources,
              (SELECT COUNT(*) FROM servers s JOIN sources src ON src.id = s.source_id
                WHERE s.enabled = 1 AND s.status IN ('alive','unknown')
                  AND src.visibility = 'shareable' AND src.kind <> 'paid_private'
                  AND s.link LIKE '%security=reality%') AS published,
              (SELECT MAX(last_sync_at) FROM sources) AS sync_at,
              (SELECT MAX(last_check_at) FROM servers) AS check_at`,
      );
      if (row) {
        counts = {
          servers: row.servers,
          alive: row.alive,
          sources: row.sources,
          published: row.published,
        };
        last = { sync_at: row.sync_at, check_at: row.check_at };
      }
      const c = await one<{
        tcp_ok: number;
        tcp_fail: number;
        tunnel_ok: number;
        tunnel_fail: number;
      }>(
        env,
        `SELECT COALESCE(SUM(kind='tcp' AND result='ok'),0)    AS tcp_ok,
              COALESCE(SUM(kind='tcp' AND result='fail'),0)  AS tcp_fail,
              COALESCE(SUM(kind='tunnel' AND result='ok'),0) AS tunnel_ok,
              COALESCE(SUM(kind='tunnel' AND result='fail'),0) AS tunnel_fail
         FROM server_checks WHERE checked_at >= datetime('now','-1 day')`,
      );
      if (c) {
        checks = {
          tcpOk: c.tcp_ok,
          tcpFail: c.tcp_fail,
          tunnelOk: c.tunnel_ok,
          tunnelFail: c.tunnel_fail,
        };
      }
      await env.CACHE.put(
        "status:counts:v1",
        JSON.stringify({ dbOk, counts, last, checks }),
        { expirationTtl: 60 },
      ).catch(() => undefined);
    } catch {
      dbOk = false;
    }
  }

  try {
    pool = await env.CACHE.get<{ verified: number; threshold: number; ts: number }>(
      "pool:health",
      "json",
    );
  } catch {
    // Нет метрики — не ошибка: сторож пишет её на ближайшем тике крона.
  }

  const state = dbOk ? "ok" : "bad";
  const stateText = dbOk ? "Сервис работает" : "База данных недоступна";

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Состояние · ${BRAND}</title><style>${CSS}</style></head><body><div class="wrap">
<div class="brand"><i>AV</i>${BRAND}</div>
<h1>Состояние сервиса</h1>
<div class="muted">Данные на ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC ·
обновление страницы при каждом запросе</div>

<div class="grid">
  <div class="card"><b class="state ${state}"><span class="dot"></span>${stateText}</b>
    <span>Проверка запроса к D1</span></div>
  <div class="card"><b>${counts.published}</b><span>конфигураций в публичной выдаче</span></div>
  <div class="card"><b>${counts.alive}</b><span>серверов отвечают (из ${counts.servers})</span></div>
  <div class="card"><b>${pool ? pool.verified : "—"}</b><span>проверено туннелем за 72 ч${
    pool ? ` · порог ${pool.threshold}` : ""
  }</span></div>
  <div class="card"><b>${counts.sources}</b><span>источников подключено</span></div>
</div>

<div class="panel">
  <div class="row"><span>Последняя синхронизация источников</span><span>${ago(last.sync_at)}</span></div>
  <div class="row"><span>Последняя проверка порта</span><span>${ago(last.check_at)}</span></div>
  <div class="row"><span>Проверки туннеля за 24 часа</span><span>${checks.tunnelOk} успешных · ${checks.tunnelFail} неудачных</span></div>
  <div class="row"><span>Проверки порта за 24 часа</span><span>${checks.tcpOk} ответил · ${checks.tcpFail} нет ответа</span></div>
  <div class="row"><span>Публичный API</span><span><a href="/api/v1/status">/api/v1/status</a> ·
    <a href="/api/v1/openapi.json">OpenAPI</a></span></div>
  <div class="row"><span>Админ-панель</span><span><a href="/admin">/admin</a></span></div>
</div>

<footer>
  «Проверка туннеля» — внешний агент поднимал Xray и проходил через узел.
  «Проверка порта» — только TCP-соединение: открытый порт сам по себе
  работоспособность VPN не подтверждает, поэтому в рейтинг идут только туннельные проверки.
</footer>
</div></body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
