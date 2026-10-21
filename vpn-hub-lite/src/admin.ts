/** Админ-страница: простой HTML, тёмная тема, никаких фреймворков. */

import { rebalance, serverLoads } from "./balance";
import { many, one, run } from "./db";
import { maskLink, maskToken } from "./labels";
import {
  adminCookieValue,
  clientIp,
  kvRateLimit,
  readCookie,
  sha256Hex,
  timingSafeEqual,
} from "./security";
import type { Env, SourceRow, UserRow } from "./types";

const COOKIE = "vh_admin";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e8ecf3;--muted:#8b95a7;--accent:#ff8a3d;--ok:#41c98a;--bad:#f2555a;--warn:#f5b84d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}
header{position:sticky;top:0;background:#12151bdd;backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;z-index:5}
header b{font-size:15px}
nav{display:flex;gap:10px;flex-wrap:wrap}
nav a{color:var(--muted);padding:4px 8px;border-radius:8px}
nav a.active{color:var(--text);background:#222834}
main{padding:14px;max-width:1100px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
h2{font-size:15px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#222834;color:var(--muted);font-size:11px;white-space:nowrap}
.pill.ok{background:#14351f;color:var(--ok)}
.pill.bad{background:#3a1d20;color:var(--bad)}
.pill.warn{background:#3a2f16;color:var(--warn)}
.btn{display:inline-block;padding:6px 10px;border-radius:9px;border:1px solid var(--line);background:#1d222b;color:var(--text);font-size:12px;cursor:pointer}
.btn:hover{border-color:var(--accent)}
.btn.danger{color:var(--bad);border-color:#40232a}
form.inline{display:inline}
input,select{padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:#12151b;color:var(--text)}
.muted{color:var(--muted);font-size:12px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.bar{height:6px;background:#222834;border-radius:4px;overflow:hidden;margin-top:4px}
.bar i{display:block;height:100%;background:var(--accent)}
.err{background:#3a1d20;color:#ffb3b7;padding:9px 12px;border-radius:10px;margin-bottom:12px}
.login{max-width:340px;margin:10vh auto}
.login input{width:100%;margin:8px 0 12px}
.login button{width:100%;padding:10px;border:0;border-radius:10px;background:var(--accent);color:#101318;font-weight:700;font-size:14px;cursor:pointer}
details summary{cursor:pointer;color:var(--muted);font-size:12px}
@media (max-width:700px){th:nth-child(3),td:nth-child(3){display:none}}
`;

function page(title: string, body: string, active: string, env: Env): Response {
  const tabs = [
    ["/admin/users", "Пользователи", "users"],
    ["/admin/servers", "Серверы", "servers"],
    ["/admin/sources", "Источники", "sources"],
    ["/admin/events", "Журнал", "events"],
  ]
    .map(
      ([href, label, key]) =>
        `<a class="${active === key ? "active" : ""}" href="${href}">${label}</a>`,
    )
    .join("");

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · VPN Hub</title><style>${CSS}</style></head><body>
<header><b>VPN Hub Lite</b><nav>${tabs}</nav>
<span style="margin-left:auto"><a href="/admin/logout">выйти</a></span></header>
<main>${body}<p class="muted">${esc(env.PUBLIC_BASE_URL)}</p></main></body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function loginPage(error = ""): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · VPN Hub</title>
<style>${CSS}</style></head><body><form class="card login" method="post" action="/admin/login">
<h2>Вход в админку</h2>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<p class="muted">Токен администратора (секрет ADMIN_TOKEN)</p>
<input type="password" name="token" autofocus autocomplete="current-password">
<button type="submit">Войти</button></form></body></html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function isAuthed(request: Request, env: Env): Promise<boolean> {
  const cookie = readCookie(request, COOKIE);
  if (!cookie) return false;
  return timingSafeEqual(cookie, await adminCookieValue(env));
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/admin/login" && request.method === "POST") {
    const ip = clientIp(request);
    if (!(await kvRateLimit(env, `adminlogin:${ip}`, 5, 600))) {
      return loginPage("Слишком много попыток. Подождите 10 минут.");
    }
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    if (!timingSafeEqual(token, env.ADMIN_TOKEN)) {
      return loginPage("Неверный токен");
    }
    const cookie = await adminCookieValue(env);
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin/users",
        "set-cookie": `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
      },
    });
  }

  if (path === "/admin/login") return loginPage();
  if (path === "/admin/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin/login",
        "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      },
    });
  }

  if (!(await isAuthed(request, env))) {
    return new Response(null, { status: 303, headers: { location: "/admin/login" } });
  }

  if (path === "/admin/action" && request.method === "POST") {
    return await handleAction(request, env);
  }

  if (path === "/admin" || path === "/admin/") {
    return new Response(null, { status: 303, headers: { location: "/admin/users" } });
  }
  if (path === "/admin/users") return await usersPage(env);
  if (path === "/admin/servers") return await serversPage(env);
  if (path === "/admin/sources") return await sourcesPage(env);
  if (path === "/admin/events") return await eventsPage(env);

  return new Response("Не найдено", { status: 404 });
}

async function csrfToken(env: Env): Promise<string> {
  return (await sha256Hex(env.ADMIN_TOKEN)).slice(0, 24);
}

async function usersPage(env: Env): Promise<Response> {
  const users = await many<
    UserRow & { devices: number; servers: number }
  >(
    env,
    `SELECT u.*,
       (SELECT COUNT(*) FROM assignments a WHERE a.user_id = u.id) AS servers,
       (SELECT COUNT(DISTINCT f.ip_hash || ':' || f.ua_hash) FROM fetch_log f
         WHERE f.user_id = u.id AND f.ts_hour >= strftime('%Y-%m-%dT%H', datetime('now','-24 hours'))) AS devices
     FROM users u ORDER BY u.created_at DESC LIMIT 100`,
  );
  const csrf = await csrfToken(env);

  const rows = users
    .map((user) => {
      const name = user.tg_username ? `@${esc(user.tg_username)}` : `id ${esc(user.tg_id)}`;
      const statusClass =
        user.status === "active" ? "ok" : user.status === "banned" ? "bad" : "warn";
      return `<tr>
        <td>${name}<div class="muted mono">${esc(user.tg_id)}</div></td>
        <td><span class="pill ${statusClass}">${esc(user.status)}</span></td>
        <td>${esc(user.expires_at?.slice(0, 10) ?? "—")}</td>
        <td>${user.devices}/${user.device_limit}<div class="muted">серверов: ${user.servers}</div></td>
        <td><details><summary>ссылка</summary>
          <div class="mono">…/sub/${esc(maskToken(user.sub_token))}</div></details></td>
        <td>
          <form class="inline" method="post" action="/admin/action">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="approve">
            <input type="hidden" name="id" value="${user.id}">
            <select name="days"><option value="7">7</option><option value="30" selected>30</option></select>
            <button class="btn">Одобрить</button>
          </form>
          <form class="inline" method="post" action="/admin/action">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="extend">
            <input type="hidden" name="id" value="${user.id}">
            <input type="hidden" name="days" value="30">
            <button class="btn">+30 дн</button>
          </form>
          <form class="inline" method="post" action="/admin/action">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="${user.status === "banned" ? "unban" : "ban"}">
            <input type="hidden" name="id" value="${user.id}">
            <button class="btn ${user.status === "banned" ? "" : "danger"}">
              ${user.status === "banned" ? "Разбанить" : "Забанить"}
            </button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const body = `<div class="card"><h2>Пользователи (${users.length})</h2>
    <table><thead><tr><th>Кто</th><th>Статус</th><th>До</th><th>Устройства</th><th>Подписка</th><th>Действия</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">Пока никого</td></tr>`}</tbody></table></div>`;

  return page("Пользователи", body, "users", env);
}

async function serversPage(env: Env): Promise<Response> {
  const servers = await serverLoads(env, 100);
  const csrf = await csrfToken(env);

  const rows = servers
    .map((server) => {
      const pct = server.max_users ? Math.round((server.load / server.max_users) * 100) : 0;
      const cls = server.status === "alive" ? "ok" : server.status === "dead" ? "bad" : "warn";
      return `<tr>
        <td class="mono">${esc(server.host)}:${server.port}</td>
        <td>${esc(server.remark || "—")}</td>
        <td><span class="pill ${cls}">${esc(server.status)}</span></td>
        <td>${server.latency_ms ?? "—"} мс</td>
        <td>${pct}% <span class="muted">(${server.load}/${server.max_users})</span>
          <div class="bar"><i style="width:${Math.min(pct, 100)}%"></i></div></td>
        <td>${esc(server.source_name)} <span class="pill">${esc(server.source_kind)}</span></td>
      </tr>`;
    })
    .join("");

  const body = `<div class="card">
    <h2>Серверы (${servers.length})</h2>
    <form method="post" action="/admin/action">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="rebalance">
      <button class="btn">Выровнять загрузку</button>
    </form>
    <form method="post" action="/admin/action" style="display:inline;margin-left:8px">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="health">
      <button class="btn">Проверить серверы сейчас</button>
    </form>
    <table style="margin-top:10px"><thead><tr><th>Адрес</th><th>Метка</th><th>Статус</th><th>Задержка</th><th>Загрузка</th><th>Источник</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">Серверов нет — добавьте источник</td></tr>`}</tbody></table>
  </div>`;
  return page("Серверы", body, "servers", env);
}

async function sourcesPage(env: Env): Promise<Response> {
  const sources = await many<SourceRow & { servers_count: number }>(
    env,
    `SELECT s.*, (SELECT COUNT(*) FROM servers srv WHERE srv.source_id = s.id) AS servers_count
     FROM sources s ORDER BY s.id`,
  );
  const csrf = await csrfToken(env);

  const rows = sources
    .map((source) => {
      const cls =
        source.status === "alive" ? "ok" : source.status === "dead" ? "bad" : "warn";
      const used = source.traffic_used ?? 0;
      const total = source.traffic_total ?? 0;
      const gb = (value: number) => (value / 1024 ** 3).toFixed(1);
      return `<tr>
        <td>${source.id}. ${esc(source.name)}
          <div class="muted">${esc(source.kind)} · ${esc(source.visibility)}</div></td>
        <td><span class="pill ${cls}">${esc(source.status)}</span></td>
        <td>${esc(source.expires_at?.slice(0, 10) ?? "—")}</td>
        <td>${total ? `${gb(used)} / ${gb(total)} ГБ` : used ? `${gb(used)} ГБ` : "—"}
          <div class="muted">серверов: ${source.servers_count}</div></td>
        <td><details><summary>ссылка</summary>
          <div class="mono">${esc(maskLink(source.url_or_link))}</div></details></td>
        <td>
          <form class="inline" method="post" action="/admin/action">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="private">
            <input type="hidden" name="id" value="${source.id}">
            <button class="btn">Приватным</button>
          </form>
          <form class="inline" method="post" action="/admin/action">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="del_source">
            <input type="hidden" name="id" value="${source.id}">
            <button class="btn danger">Удалить</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const body = `<div class="card">
    <h2>Источники (${sources.length})</h2>
    <form method="post" action="/admin/action" style="margin-bottom:10px">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="sync">
      <button class="btn">Обновить источники сейчас</button>
      <span class="muted">обычно раз в 6 часов по cron</span>
    </form>
    <table><thead><tr><th>Название</th><th>Статус</th><th>Срок</th><th>Трафик</th><th>Ссылка</th><th>Действия</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">Источников нет — /addkey в боте</td></tr>`}</tbody></table></div>`;

  return page("Источники", body, "sources", env);
}

async function eventsPage(env: Env): Promise<Response> {
  const events = await many<{ ts: string; type: string; user_id: number | null; details: string }>(
    env,
    "SELECT ts, type, user_id, details FROM events ORDER BY id DESC LIMIT 80",
  );

  const rows = events
    .map(
      (event) => `<tr><td class="mono">${esc(event.ts)}</td>
        <td><span class="pill">${esc(event.type)}</span></td>
        <td class="muted">${event.user_id ?? ""}</td>
        <td>${esc(event.details)}</td></tr>`,
    )
    .join("");

  const body = `<div class="card"><h2>Журнал</h2>
    <table><tbody>${rows || `<tr><td class="muted">Пусто</td></tr>`}</tbody></table></div>`;
  return page("Журнал", body, "events", env);
}

async function handleAction(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const csrf = String(form.get("csrf") ?? "");
  if (!timingSafeEqual(csrf, await csrfToken(env))) {
    return new Response("CSRF", { status: 403 });
  }

  const action = String(form.get("action") ?? "");
  const id = Number(form.get("id") ?? 0);
  const days = Number(form.get("days") ?? 30);

  if (action === "approve" || action === "extend") {
    const delta = Number.isFinite(days) ? days : 30;
    const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", id);
    if (user) {
      const { approveUser } = await import("./bot/user");
      if (action === "approve") {
        await approveUser(env, id, delta);
      } else {
        const base = user.expires_at
          ? new Date(user.expires_at.replace(" ", "T") + "Z")
          : new Date();
        const from = Math.max(base.getTime(), Date.now());
        const next = new Date(from + delta * 86400_000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ");
        await run(
          env,
          "UPDATE users SET status='active', expires_at=? WHERE id=?",
          next,
          id,
        );
      }
    }
  } else if (action === "ban" || action === "unban") {
    await run(
      env,
      "UPDATE users SET status = ? WHERE id = ?",
      action === "ban" ? "banned" : "active",
      id,
    );
  } else if (action === "private") {
    await run(env, "UPDATE sources SET visibility='private' WHERE id = ?", id);
    await run(
      env,
      "DELETE FROM assignments WHERE server_id IN (SELECT id FROM servers WHERE source_id = ?)",
      id,
    );
  } else if (action === "del_source") {
    await run(env, "DELETE FROM sources WHERE id = ?", id);
  } else if (action === "rebalance") {
    await rebalance(env);
  } else if (action === "sync") {
    const { runSync } = await import("./sync");
    await runSync(env);
  } else if (action === "health") {
    const { runHealth } = await import("./health");
    await runHealth(env);
  }

  const back =
    action === "rebalance" || action === "health"
      ? "/admin/servers"
      : action === "sync"
        ? "/admin/sources"
        : request.headers.get("Referer") ?? "/admin/users";
  return new Response(null, {
    status: 303,
    headers: { location: back.startsWith("/admin") ? back : "/admin/users" },
  });
}
