/** Админка: каркас дашборда — сайдбар, топбар, KPI, график, «бублик», кольца. */

import { rebalance, serverLoads } from "./balance";
import { deliverSource, topUpAllActive } from "./delivery";
import { createInvite, inviteLink, listInvites, revokeInvite } from "./invites";
import { logEvent, many, one, run } from "./db";
import { syncOneSource } from "./sync";
import { maskLink, maskToken } from "./labels";
import { BRAND } from "./brand";
import {
  adminCookieValue,
  clientIp,
  envStr,
  kvRateLimit,
  readCookie,
  sha256Hex,
  timingSafeEqual,
} from "./security";
import type { Env, SourceRow, UserRow } from "./types";
import {
  cancelAccrual,
  grantSquad,
  invalidateSettings,
  loadSettings,
  revokeSquad,
  saveSetting,
  SQUADS,
} from "./bonus";
import {
  BANNER_KEYS,
  BANNER_LABELS,
  isBannerKey,
  resetBannerFile,
  saveBannerFile,
} from "./banners";
import { normalizePromo, randomPromoCode } from "./promotions";

const COOKIE = "vh_admin";
const GB = 1024 ** 3;

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
:root{
  --bg:#07142c; --panel:rgba(255,255,255,.055); --panel-2:rgba(255,255,255,.09);
  --line:rgba(255,255,255,.12); --text:#EAF2FF; --muted:#93A9C8;
  --accent:#4FE3C1; --ok:#4FE3C1; --bad:#FF6B6B; --warn:#FFB454; --violet:#8B93FF;
  --r-sm:10px; --r-md:14px; --r-lg:20px;
  --sp-1:6px; --sp-2:10px; --sp-3:14px; --sp-4:20px; --sp-5:28px;
  --shadow:0 18px 40px rgba(3,9,25,.28);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:
    radial-gradient(1200px 700px at 10% -10%,#1f3d8a 0,transparent 55%),
    radial-gradient(900px 600px at 100% 0,#4a2f8f 0,transparent 50%),
    linear-gradient(160deg,#07142c 0,#0d1b3f 50%,#141b46 100%);
  background-attachment:fixed;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}

.layout{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.side{background:rgba(6,15,34,.66);backdrop-filter:blur(14px);border-right:1px solid var(--line);
  padding:var(--sp-4) var(--sp-3);display:flex;flex-direction:column;gap:2px;
  position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;letter-spacing:-.01em;
  margin-bottom:var(--sp-4);padding:0 6px}
.brand i{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--violet));
  display:grid;place-items:center;color:#07142c;font-style:normal;font-weight:800;font-size:10px}
.group{color:var(--muted);font-size:10px;letter-spacing:.1em;margin:var(--sp-3) 8px 4px;text-transform:uppercase;opacity:.7}
.side a{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:var(--r-sm);
  color:var(--muted);font-size:13.5px;transition:background .15s,color .15s,transform .12s}
.side a:hover{background:var(--panel-2);color:var(--text);text-decoration:none}
.side a:active{transform:scale(.99)}
.side a.active{background:var(--panel-2);color:var(--text);box-shadow:inset 2px 0 0 var(--accent);font-weight:500}
.side .spacer{flex:1}
.side .out{color:var(--muted);font-size:12.5px;padding:8px 10px}

.top{display:flex;align-items:center;gap:12px;padding:12px var(--sp-5);border-bottom:1px solid var(--line);
  background:rgba(8,18,40,.62);backdrop-filter:blur(14px);position:sticky;top:0;z-index:10}
.top .search{flex:0 1 380px;position:relative}
.top input{width:100%;padding:10px 14px;border-radius:var(--r-sm);border:1px solid var(--line);
  background:rgba(5,12,28,.55);color:var(--text);font-size:13.5px;transition:border-color .15s,box-shadow .15s}
.top input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(79,227,193,.12);outline:none}
.top .spacer{flex:1}
.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:var(--r-sm);
  background:var(--panel);color:var(--muted);font-size:12px;white-space:nowrap}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);opacity:.85}
.me{display:flex;align-items:center;gap:9px}
.me .ava{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#8B93FF,#4FE3C1);
  display:grid;place-items:center;color:#07142c;font-weight:700;font-size:12px}
.me b{display:block;font-size:12.5px;line-height:1.2}
.me span{color:var(--muted);font-size:11px}

main{padding:var(--sp-5);max-width:1240px;width:100%}
h1{font-size:26px;margin:0 0 2px;letter-spacing:-.025em}
.sub{color:var(--muted);font-size:13.5px;margin-bottom:var(--sp-4)}

/* вход карточек */
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
main > *{animation:rise .38s cubic-bezier(.2,.7,.3,1) both}
main > *:nth-child(2){animation-delay:.05s}
main > *:nth-child(3){animation-delay:.1s}
main > *:nth-child(4){animation-delay:.15s}
main > *:nth-child(5){animation-delay:.2s}

.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--sp-3);margin-bottom:var(--sp-4)}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--sp-3) var(--sp-4);
  backdrop-filter:blur(14px);transition:transform .18s,border-color .18s,background .18s}
.kpi:hover{transform:translateY(-2px);border-color:rgba(79,227,193,.35);background:var(--panel-2)}
.kpi .row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.kpi .n{font-size:28px;font-weight:650;letter-spacing:-.03em;line-height:1.1}
.kpi .ico{opacity:.55;font-size:15px}
.kpi .bar{height:4px;border-radius:99px;background:rgba(255,255,255,.14);margin:12px 0 9px;overflow:hidden}
.kpi .bar i{display:block;height:100%;background:linear-gradient(90deg,#8B93FF,#4FE3C1);border-radius:inherit;
  animation:grow .7s ease both}
@keyframes grow{from{transform:scaleX(0);transform-origin:left}}
.kpi .bar i.warn{background:linear-gradient(90deg,#FFB454,#FF8A5B)}
.kpi .f{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
.kpi .f b{color:var(--text);font-weight:500}

.grid{display:grid;grid-template-columns:1.7fr 1fr;gap:var(--sp-3);margin-bottom:var(--sp-4)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--sp-4);
  backdrop-filter:blur(14px);box-shadow:var(--shadow);margin-bottom:var(--sp-3);
  transition:border-color .18s}
.card:hover{border-color:rgba(255,255,255,.2)}
.card h2{font-size:15px;margin:0 0 var(--sp-3);letter-spacing:-.01em;font-weight:600}
.card .head{display:flex;align-items:center;gap:10px;margin-bottom:var(--sp-3);flex-wrap:wrap}
.card .head .spacer{flex:1}

.chart{width:100%;height:210px;display:block}
.labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px;gap:6px}
.labels span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:88px}
.foot{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:var(--sp-3);
  padding-top:var(--sp-3);border-top:1px solid var(--line);text-align:center}
.foot b{display:block;font-size:19px;letter-spacing:-.02em}
.foot span{font-size:11.5px;color:var(--muted)}
.donut-wrap{display:grid;place-items:center;padding:2px 0 10px}
.donut{width:100%;max-width:190px}
.legend{display:grid;gap:8px}
.lrow{display:grid;grid-template-columns:10px 1fr auto auto;gap:8px;align-items:center;font-size:13px}
.lrow i{width:10px;height:10px;border-radius:50%}
.lrow .pct{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:500}

.minis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--sp-3);margin-bottom:var(--sp-4)}
.mini{display:flex;align-items:center;gap:14px;margin-bottom:0}
.ring{width:58px;height:58px;flex:none;border-radius:50%;display:grid;place-items:center;position:relative;
  background:conic-gradient(var(--accent) calc(var(--p) * 1%),rgba(255,255,255,.12) 0);
  transition:background .3s}
.ring::after{content:"";position:absolute;inset:7px;border-radius:50%;background:#111c40}
.ring span{position:relative;z-index:1;font-size:12px;font-weight:600}
.mini b{display:block;font-size:13px}
.mini .muted{font-size:12px}

table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:11px;letter-spacing:.02em;position:sticky;top:0;
  background:rgba(10,22,48,.9);backdrop-filter:blur(8px);z-index:1}
tr:last-child td{border-bottom:0}
tbody tr{transition:background .14s}
tbody tr:hover{background:rgba(79,227,193,.05)}

.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:99px;
  background:rgba(255,255,255,.09);color:var(--muted);font-size:11px;white-space:nowrap}
.pill::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.9}
.pill.ok{background:rgba(79,227,193,.15);color:var(--ok)}
.pill.bad{background:rgba(255,107,107,.15);color:var(--bad)}
.pill.warn{background:rgba(255,180,84,.15);color:var(--warn)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  padding:8px 13px;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--panel-2);
  color:var(--text);font-size:12.5px;cursor:pointer;transition:border-color .15s,background .15s,transform .1s}
.btn:hover{border-color:var(--accent);background:rgba(79,227,193,.08);text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn.primary{background:var(--accent);color:#06231d;border-color:transparent;font-weight:600}
.btn.primary:hover{filter:brightness(1.06);background:var(--accent)}
.btn.danger{color:var(--bad);border-color:rgba(255,107,107,.45);background:transparent}
.btn.danger:hover{background:rgba(255,107,107,.1);border-color:var(--bad)}

form.inline{display:inline}
input,select,textarea,button{font:inherit}
input,select,textarea{padding:8px 10px;border-radius:var(--r-sm);border:1px solid var(--line);
  background:rgba(5,12,28,.55);color:var(--text);font-size:13px;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(79,227,193,.12);outline:none}
td input,td select{padding:5px 7px;font-size:12px}

.muted{color:var(--muted);font-size:12px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.notice{background:rgba(79,227,193,.12);border:1px solid rgba(79,227,193,.35);padding:10px 13px;
  border-radius:var(--r-sm);margin-bottom:var(--sp-3);font-size:13px;animation:rise .3s ease both}
.err{background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.35);padding:10px 13px;
  border-radius:var(--r-sm);margin-bottom:var(--sp-3);font-size:13px;animation:rise .3s ease both}
details summary{cursor:pointer;color:var(--muted);font-size:12px;transition:color .15s}
details summary:hover{color:var(--text)}

.login{max-width:380px;margin:14vh auto}
.login h2{margin-bottom:4px}
.login input{width:100%;margin:10px 0 14px}
.login button{width:100%;padding:12px;border:0;border-radius:var(--r-sm);background:var(--accent);
  color:#06231d;font-weight:700;cursor:pointer;transition:transform .12s,filter .15s}
.login button:hover{filter:brightness(1.06)}
.login button:active{transform:translateY(1px)}

/* ── Планшет ─────────────────────────────────────────────────────────── */
@media (max-width:1100px){
  .layout{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;align-items:center;gap:4px;
    overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:10px 14px}
  .brand{margin:0 12px 0 0;flex:none}
  .group{display:none}
  .side a{white-space:nowrap;flex:none;padding:7px 11px}
  .side .spacer,.side .out{display:none}
  .grid{grid-template-columns:1fr}
  main{padding:var(--sp-4)}
}
@media (max-width:820px){
  .kpis,.minis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .top{padding:10px 14px;gap:8px}
  .top .search{display:none}
  .card{overflow-x:auto}
  table{min-width:660px}
  th{position:static}
}
@media (max-width:560px){
  .kpis,.minis{grid-template-columns:1fr}
  h1{font-size:22px}
  .chip{display:none}
  .me span{display:none}
}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none !important;transition:none !important}
}
`;

const NAV: Array<[string, string, string, string]> = [
  ["Дашборд", "/admin", "Обзор", "overview"],
  ["Дашборд", "/admin/users", "Пользователи", "users"],
  ["Данные", "/admin/servers", "Серверы", "servers"],
  ["Данные", "/admin/sources", "Источники", "sources"],
  ["Доступ", "/admin/grant", "Выдать подписку", "grant"],
  ["Маркетинг", "/admin/bonuses", "Настройки бонусов", "bonuses"],
  ["Маркетинг", "/admin/promos", "Промокоды", "promos"],
  ["Маркетинг", "/admin/accruals", "Начисления", "accruals"],
  ["Маркетинг", "/admin/banners", "Баннеры", "banners"],
  ["Маркетинг", "/admin/squads", "Группы", "squads"],
  ["Журнал", "/admin/events", "События", "events"],
];

function sidebar(active: string): string {
  let html = "";
  let group = "";
  for (const [section, href, label, key] of NAV) {
    if (section !== group) {
      html += `<div class="group">${section}</div>`;
      group = section;
    }
    html += `<a class="${active === key ? "active" : ""}" href="${href}">${label}</a>`;
  }
  return html;
}

function page(title: string, body: string, active: string, env: Env): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${BRAND}</title><style>${CSS}</style></head><body>
<div class="layout">
  <aside class="side">
    <div class="brand"><i>AV</i> ${BRAND}</div>
    ${sidebar(active)}
    <div class="spacer"></div>
    <a class="out" href="/admin/logout">Выйти</a>
  </aside>
  <div>
    <header class="top">
      <form class="search" onsubmit="return false">
        <input id="q" placeholder="Поиск по таблице…" oninput="filterRows(this.value)" aria-label="Поиск">
      </form>
      <div class="spacer"></div>
      <span class="chip" id="net">сеть: —</span>
      <span class="chip">${esc(env.PUBLIC_BASE_URL.replace(/^https?:\/\//, ""))}</span>
      <div class="me"><div class="ava">A</div><div><b>Админ</b><span>${esc(env.ADMIN_TG_ID ?? "")}</span></div></div>
    </header>
    <main>${body}</main>
  </div>
</div>
<script>
function filterRows(value) {
  const needle = (value || "").toLowerCase().trim();
  document.querySelectorAll("tbody tr[data-row]").forEach((row) => {
    row.style.display = !needle || row.dataset.row.toLowerCase().includes(needle) ? "" : "none";
  });
}
fetch("/healthz").then((r) => { if (r.ok) document.getElementById("net").textContent = "сеть: ok"; })
  .catch(() => { document.getElementById("net").textContent = "сеть: нет"; });
</script>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function loginPage(error = ""): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · ${BRAND}</title>
<style>${CSS}</style></head><body>
<form class="card login" method="post" action="/admin/login">
  <h2>${BRAND}</h2>
  <p class="muted" style="margin:0 0 12px">Токен администратора (ADMIN_TOKEN)</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <input type="password" name="token" autofocus autocomplete="current-password" placeholder="Токен">
  <button type="submit">Войти</button>
</form></body></html>`;
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

async function csrfToken(env: Env): Promise<string> {
  return (await sha256Hex(envStr(env.ADMIN_TOKEN))).slice(0, 24);
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
    if (!timingSafeEqual(String(form.get("token") ?? ""), envStr(env.ADMIN_TOKEN))) {
      return loginPage("Неверный токен");
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin",
        "set-cookie": `${COOKIE}=${await adminCookieValue(env)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
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

  if (path === "/admin" || path === "/admin/") return await overviewPage(env);
  if (path === "/admin/users") return await usersPage(env, url);
  if (path === "/admin/servers") return await serversPage(env, url);
  if (path === "/admin/server") return await serverEditPage(env, url);
  if (path === "/admin/sources") return await sourcesPage(env, url);
  if (path === "/admin/grant") return await grantPage(env, url);
  if (path === "/admin/bonuses") return await bonusesPage(env, url);
  if (path === "/admin/promos") return await promosPage(env, url);
  if (path === "/admin/accruals") return await accrualsPage(env, url);
  if (path === "/admin/banners") return await bannersPage(env, url);
  if (path === "/admin/squads") return await squadsPage(env, url);
  if (path.startsWith("/admin/banner-file/")) {
    return await bannerFileResponse(env, path.slice("/admin/banner-file/".length));
  }
  if (path === "/admin/events") return await eventsPage(env);

  return new Response("Не найдено", { status: 404 });
}

/* ── SVG ──────────────────────────────────────────────────────────────── */

function areaPath(values: number[]): { area: string; line: string; dots: Array<[number, number]> } {
  if (values.length < 2) return { area: "", line: "", dots: [] };
  const width = 620;
  const height = 190;
  const pad = 16;
  const top = Math.max(...values, 1);
  const step = (width - pad * 2) / (values.length - 1);
  const dots: Array<[number, number]> = values.map((value, index) => [
    pad + index * step,
    height - pad - (value / top) * (height - pad * 3),
  ]);
  const line = dots.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area =
    `M${dots[0][0].toFixed(1)},${height - pad} L` +
    dots.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L") +
    ` L${dots[dots.length - 1][0].toFixed(1)},${height - pad} Z`;
  return { area, line, dots };
}

function donutSegments(parts: Array<{ label: string; value: number; color: string }>) {
  const total = parts.reduce((sum, part) => sum + part.value, 0) || 1;
  let offset = 0;
  return parts
    .filter((part) => part.value > 0)
    .map((part) => {
      const length = 2 * Math.PI * 70 * (part.value / total);
      const segment = {
        ...part,
        pct: Math.round((100 * part.value) / total),
        dash: length.toFixed(1),
        gap: (439.8 - length).toFixed(1),
        offset: (-offset).toFixed(1),
      };
      offset += length;
      return segment;
    });
}

/* ── Обзор ─────────────────────────────────────────────────────────────── */

async function overviewPage(env: Env): Promise<Response> {
  const users = await many<UserRow>(env, "SELECT * FROM users ORDER BY created_at DESC LIMIT 500");
  const servers = await serverLoads(env, 300);
  const sources = await many<{ status: string }>(env, "SELECT status FROM sources");
  const csrf = await csrfToken(env);

  const aliveServers = servers.filter((s) => s.status === "alive");
  const active = users.filter((u) => u.status === "active").length;
  const pending = users.filter((u) => u.status === "pending").length;
  const expiring = users.filter((u) => {
    if (!u.expires_at) return false;
    return Date.parse(u.expires_at.replace(" ", "T") + "Z") - Date.now() < 3 * 86400_000;
  }).length;
  const sourceAlive = sources.filter((s) => s.status === "alive").length;
  const pct = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0);

  const chartServers = aliveServers.filter((s) => s.latency_ms).slice(0, 12);
  const chart = areaPath(chartServers.map((s) => s.latency_ms ?? 0));

  const segments = donutSegments([
    { label: "Активные", value: active, color: "#4FE3C1" },
    { label: "Ждут", value: pending, color: "#FFB454" },
    { label: "Забанены", value: users.filter((u) => u.status === "banned").length, color: "#FF6B6B" },
    { label: "Истекли", value: users.filter((u) => u.status === "expired").length, color: "#8B93FF" },
  ]);
  const legend = segments
    .map(
      (seg) => `<div class="lrow"><i style="background:${seg.color}"></i><span>${seg.label}</span>
        <span class="muted">${seg.value}</span><span class="pct">${seg.pct}%</span></div>`,
    )
    .join("");

  const body = `
<h1>Обзор</h1>
<div class="sub">Сколько людей, серверов и источников прямо сейчас</div>

<div class="kpis">
  <div class="kpi"><div class="row"><span class="n">${users.length}</span><span class="ico">👥</span></div>
    <div class="bar"><i style="width:${pct(active, users.length)}%"></i></div>
    <div class="f"><b>Люди</b><span>активных ${active}</span></div></div>
  <div class="kpi"><div class="row"><span class="n">${aliveServers.length}<small class="muted">/${servers.length}</small></span><span class="ico">🛰</span></div>
    <div class="bar"><i style="width:${pct(aliveServers.length, servers.length)}%"></i></div>
    <div class="f"><b>Серверы</b><span>живых</span></div></div>
  <div class="kpi"><div class="row"><span class="n">${sourceAlive}<small class="muted">/${sources.length}</small></span><span class="ico">📥</span></div>
    <div class="bar"><i class="warn" style="width:${pct(sourceAlive, sources.length)}%"></i></div>
    <div class="f"><b>Источники</b><span>отвечают</span></div></div>
  <div class="kpi"><div class="row"><span class="n">${pending}</span><span class="ico">⏳</span></div>
    <div class="bar"><i class="warn" style="width:${pct(pending, users.length)}%"></i></div>
    <div class="f"><b>Заявки</b><span>истекают: ${expiring}</span></div></div>
</div>

<div class="grid">
  <div class="card">
    <div class="head"><h2>Задержка серверов</h2><div class="spacer"></div><span class="muted">мс, меньше — лучше</span></div>
    ${chart.area
      ? `<svg viewBox="0 0 620 190" class="chart" preserveAspectRatio="none" role="img" aria-label="Задержка серверов">
           <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
             <stop offset="0%" stop-color="#8B93FF" stop-opacity=".55"/>
             <stop offset="100%" stop-color="#8B93FF" stop-opacity="0"/>
           </linearGradient></defs>
           <path d="${chart.area}" fill="url(#f)"/>
           <polyline points="${chart.line}" fill="none" stroke="#C8CEFF" stroke-width="2.5" stroke-linejoin="round"/>
           ${chart.dots.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#EAF2FF"/>`).join("")}
         </svg>
         <div class="labels">${chartServers.map((s) => `<span>${esc(s.host)}</span>`).join("")}</div>`
      : `<div class="muted" style="padding:40px 0;text-align:center">График появится, когда серверы ответят с задержкой</div>`}
    <div class="foot">
      <div><b>${aliveServers.length}</b><span>живых серверов</span></div>
      <div><b>${active}</b><span>активных людей</span></div>
      <div><b>${expiring}</b><span>истекают</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Люди по статусу</h2>
    <div class="donut-wrap">
      <svg viewBox="0 0 180 180" class="donut" role="img" aria-label="Люди по статусу">
        <circle cx="90" cy="90" r="70" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="18"/>
        <g transform="rotate(-90 90 90)">
          ${segments.map((seg) => `<circle cx="90" cy="90" r="70" fill="none" stroke="${seg.color}" stroke-width="18"
            stroke-dasharray="${seg.dash} ${seg.gap}" stroke-dashoffset="${seg.offset}"/>`).join("")}
        </g>
        <text x="90" y="86" text-anchor="middle" fill="#EAF2FF" font-size="28" font-weight="600">${users.length}</text>
        <text x="90" y="106" text-anchor="middle" fill="#93A9C8" font-size="11">людей</text>
      </svg>
    </div>
    <div class="legend">${legend || `<div class="muted">Пока никого</div>`}</div>
  </div>
</div>

<div class="minis">
  <div class="card mini"><div class="ring" style="--p:${pct(aliveServers.length, servers.length)}"><span>${pct(aliveServers.length, servers.length)}%</span></div>
    <div><b>Серверы</b><div class="muted">${aliveServers.length} живых из ${servers.length}</div></div></div>
  <div class="card mini"><div class="ring" style="--p:${pct(active, users.length)}"><span>${pct(active, users.length)}%</span></div>
    <div><b>Люди</b><div class="muted">${active} активных, ${pending} ждут</div></div></div>
  <div class="card mini"><div class="ring" style="--p:${pct(sourceAlive, sources.length)}"><span>${pct(sourceAlive, sources.length)}%</span></div>
    <div><b>Источники</b><div class="muted">${sourceAlive} отвечают, ${sources.length - sourceAlive} молчат</div></div></div>
</div>

<div class="card">
  <div class="head"><h2>Быстрые действия</h2></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="sync">
      <button class="btn primary">Обновить источники</button>
    </form>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="health">
      <button class="btn">Проверить серверы</button>
    </form>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="menu">
      <button class="btn">Отправить меню в Telegram</button>
    </form>
  </div>
</div>`;

  return page("Обзор", body, "overview", env);
}

/* ── Пользователи ──────────────────────────────────────────────────────── */

interface PoolRow {
  id: number;
  name: string;
}

async function usersPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const users = await many<UserRow & { devices: number; servers: number }>(
    env,
    `SELECT u.*,
       (SELECT COUNT(*) FROM assignments a WHERE a.user_id = u.id) AS servers,
       (SELECT COUNT(DISTINCT f.ip_hash || ':' || f.ua_hash) FROM fetch_log f
         WHERE f.user_id = u.id AND f.ts_hour >= strftime('%Y-%m-%dT%H', datetime('now','-24 hours'))) AS devices
     FROM users u ORDER BY u.created_at DESC LIMIT 200`,
  );
  const pools = await many<PoolRow>(env, "SELECT id, name FROM pools ORDER BY id");
  const allSources = await many<{ id: number; name: string; max_devices: number }>(
    env,
    "SELECT id, name, max_devices FROM sources ORDER BY id",
  );
  const slotRows = await many<{ user_id: number; source_id: number; name: string }>(
    env,
    `SELECT us.user_id, us.source_id, src.name FROM user_sources us
     JOIN sources src ON src.id = us.source_id`,
  );
  const userSlots = new Map<number, Array<{ id: number; name: string }>>();
  for (const row of slotRows) {
    const list = userSlots.get(row.user_id) ?? [];
    list.push({ id: row.source_id, name: row.name });
    userSlots.set(row.user_id, list);
  }
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");

  const rows = users
    .map((user) => {
      const name = user.tg_username ? `@${esc(user.tg_username)}` : `id ${esc(user.tg_id)}`;
      const cls = user.status === "active" ? "ok" : user.status === "banned" ? "bad" : "warn";
      const traffic = user.traffic_gb ? `${user.traffic_gb} ГБ` : "—";
      return `<tr data-row="${esc(user.tg_id)} ${esc(user.tg_username || "")}">
        <td>${name}<div class="muted mono">${esc(user.tg_id)}</div></td>
        <td><span class="pill ${cls}">${esc(user.status)}</span></td>
        <td>${esc(user.expires_at?.slice(0, 10) ?? "—")}</td>
        <td>${user.devices}/${user.device_limit}<div class="muted">серверов: ${user.servers}</div></td>
        <td>${traffic}</td>
        <td><details><summary>ссылка</summary><div class="mono">…/sub/${esc(maskToken(user.sub_token))}</div></details></td>
        <td>
          <details>
            <summary>Изменить</summary>
            <form method="post" action="/admin/action" style="display:grid;gap:6px;margin-top:6px;min-width:210px">
              <input type="hidden" name="csrf" value="${csrf}">
              <input type="hidden" name="action" value="update_user">
              <input type="hidden" name="id" value="${user.id}">
              <label class="muted">Срок</label>
              <div style="display:flex;gap:6px">
                <select name="days">
                  <option value="0">не менять</option>
                  <option value="7">+7 дней</option>
                  <option value="30" selected>+30 дней</option>
                  <option value="90">+90 дней</option>
                  <option value="-30">−30 дней</option>
                </select>
                <input type="date" name="date" aria-label="Точная дата">
              </div>
              <label class="muted">Трафик, ГБ (0 — без лимита)</label>
              <input name="traffic" value="${user.traffic_gb ?? 0}" inputmode="numeric">
              <label class="muted">Устройств</label>
              <input name="devices_limit" value="${user.device_limit}" inputmode="numeric">
              <label class="muted">Группа серверов</label>
              <select name="pool">
                <option value="0">не менять</option>
                ${pools.map((pool) => `<option value="${pool.id}">${esc(pool.name)}</option>`).join("")}
              </select>
              <button class="btn primary" type="submit">Сохранить</button>
            </form>

            <div class="muted" style="margin-top:8px">Слоты на источниках</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
              ${(userSlots.get(user.id) ?? []).map((slot) => `
                <form method="post" action="/admin/action" class="inline">
                  <input type="hidden" name="csrf" value="${csrf}">
                  <input type="hidden" name="action" value="del_slot">
                  <input type="hidden" name="id" value="${user.id}">
                  <input type="hidden" name="source_id" value="${slot.id}">
                  <button class="btn" title="Забрать слот">${esc(slot.name)} ×</button>
                </form>`).join("") || `<span class="muted">нет</span>`}
            </div>
            <form method="post" action="/admin/action" style="display:flex;gap:4px;margin-top:6px">
              <input type="hidden" name="csrf" value="${csrf}">
              <input type="hidden" name="action" value="add_slot">
              <input type="hidden" name="id" value="${user.id}">
              <select name="source_id" aria-label="Источник">
                ${allSources.filter((item) => item.max_devices > 0)
                  .map((item) => `<option value="${item.id}">${esc(item.name)} (${item.max_devices})</option>`)
                  .join("") || `<option value="0">лимитов нет</option>`}
              </select>
               <button class="btn">Дать слот</button>
             </form>
             <a class="btn" href="/admin/accruals?user=${user.id}" style="display:inline-block;margin-top:8px;text-decoration:none">Журнал начислений</a>
           </details>
          <form method="post" action="/admin/action" class="inline" style="margin-top:6px">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="${user.status === "banned" ? "unban" : "ban"}">
            <input type="hidden" name="id" value="${user.id}">
            <button class="btn ${user.status === "banned" ? "" : "danger"}">${user.status === "banned" ? "Разбанить" : "Забанить"}</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const body = `
<h1>Пользователи</h1>
<div class="sub">Срок, трафик, устройства и группа серверов задаются вручную</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <form method="post" action="/admin/action" style="margin-bottom:10px">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="selftest">
    <button class="btn">Проверить мою подписку</button>
    <span class="muted">покажет, сколько серверов реально уходит в Happ</span>
  </form>
  <table>
    <thead><tr><th>Кто</th><th>Статус</th><th>До</th><th>Устройства</th><th>Трафик</th><th>Подписка</th><th>Действия</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">Пока никого</td></tr>`}</tbody>
  </table>
</div>

<div class="card">
  <div class="head"><h2>Выдать доступ вручную</h2></div>
  <p class="muted" style="margin-top:0">Человек должен сначала написать боту /start — тогда он появится в списке.</p>
  <form method="post" action="/admin/action" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="grant">
    <div><label class="muted">Telegram ID</label><br><input name="tg_id" placeholder="123456789" required></div>
    <div><label class="muted">Дней</label><br><input name="days" value="30" inputmode="numeric" style="width:90px"></div>
    <div><label class="muted">ГБ</label><br><input name="traffic" value="100" inputmode="numeric" style="width:90px"></div>
    <div><label class="muted">Устройств</label><br><input name="devices_limit" value="2" inputmode="numeric" style="width:100px"></div>
    <div><label class="muted">Группа</label><br>
      <select name="pool"><option value="0">все</option>
        ${pools.map((pool) => `<option value="${pool.id}">${esc(pool.name)}</option>`).join("")}
      </select>
    </div>
    <button class="btn primary">Выдать</button>
  </form>
  <form method="post" action="/admin/action" style="margin-top:12px">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="selftest">
    <button class="btn">Проверить мою подписку</button>
    <span class="muted">покажет, сколько серверов реально уходит в Happ</span>
  </form>
</div>`;

  return page("Пользователи", body, "users", env);
}

/* ── Серверы ───────────────────────────────────────────────────────────── */

async function serversPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");

  const q = (url.searchParams.get("q") ?? "").trim();
  const st = url.searchParams.get("st") ?? "";
  const tier = url.searchParams.get("tier") ?? "";
  const country = url.searchParams.get("country") ?? "";
  const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const per = 40;

  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    where.push("(s.host LIKE ? OR s.remark LIKE ? OR s.country_name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (st === "on") where.push("s.enabled = 1 AND s.status = 'alive'");
  if (st === "off") where.push("s.enabled = 0");
  if (st === "dead") where.push("s.enabled = 1 AND s.status = 'dead'");
  if (st === "unknown") where.push("s.enabled = 1 AND s.status = 'unknown'");
  if (tier) {
    where.push("s.tier = ?");
    params.push(tier);
  }
  if (country) {
    where.push("s.country_code = ?");
    params.push(country);
  }

  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows, totals, countries] = await Promise.all([
    many<{
      id: number;
      host: string;
      port: number;
      remark: string;
      status: string;
      enabled: number;
      tier: string;
      country_name: string | null;
      city: string | null;
      country_code: string | null;
      latency_ms: number | null;
      last_check_at: string | null;
      users: number;
    }>(
      env,
      `SELECT s.id, s.host, s.port, s.remark, s.status, s.enabled, s.tier,
              s.country_name, s.city, s.country_code, s.latency_ms, s.last_check_at,
              (SELECT COUNT(*) FROM assignments a WHERE a.server_id = s.id) AS users
         FROM servers s ${filter}
        ORDER BY s.enabled DESC, s.priority DESC, (s.status = 'alive') DESC,
                 (s.latency_ms IS NULL), s.latency_ms, s.id
        LIMIT ? OFFSET ?`,
      ...params,
      per,
      (pageNo - 1) * per,
    ),
    one<{ total: number }>(env, `SELECT COUNT(*) AS total FROM servers s ${filter}`, ...params),
    many<{ country_code: string; country_name: string; n: number }>(
      env,
      `SELECT country_code, country_name, COUNT(*) AS n FROM servers
        WHERE country_code IS NOT NULL AND country_code <> ''
        GROUP BY country_code ORDER BY n DESC LIMIT 40`,
    ),
  ]);

  const total = totals?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));

  const statusPill = (server: { enabled: number; status: string }) => {
    if (!server.enabled) return `<span class="pill">выключен</span>`;
    if (server.status === "alive") return `<span class="pill ok">ONLINE</span>`;
    if (server.status === "dead") return `<span class="pill bad">OFFLINE</span>`;
    return `<span class="pill warn">UNKNOWN</span>`;
  };

  const when = (value: string | null) => {
    if (!value) return "—";
    const ts = Date.parse(`${value.replace(" ", "T")}Z`);
    if (!Number.isFinite(ts)) return "—";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "только что";
    if (mins < 60) return `${mins} мин назад`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} ч назад`;
    return `${Math.round(hours / 24)} дн назад`;
  };

  const body_rows = rows
    .map((server) => {
      const name = server.country_name
        ? `VLESS · ${server.country_name}${server.city && server.city.length <= 16 ? ` · ${server.city}` : ""}`
        : "VLESS · Регион неизвестен";
      return `<tr data-row="${esc(server.host)}">
        <td><input type="checkbox" name="ids" value="${server.id}" form="bulk"></td>
        <td>${esc(name)}
          <div class="muted mono" style="font-size:11px">${esc(server.host)}:${server.port} · #${server.id}</div></td>
        <td>${statusPill(server)}</td>
        <td>${server.latency_ms ?? "—"} мс</td>
        <td><span class="pill">${esc(server.tier)}</span></td>
        <td>${server.users}</td>
        <td class="muted">${when(server.last_check_at)}</td>
        <td style="white-space:nowrap">
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="server_toggle">
            <input type="hidden" name="id" value="${server.id}">
            <button class="btn">${server.enabled ? "Выключить" : "Включить"}</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="check_ids">
            <input type="hidden" name="ids" value="${server.id}">
            <button class="btn">Проверить</button>
          </form>
          <form method="post" action="/admin/action" class="inline"
                onsubmit="return confirm('Удалить сервер ${esc(server.host)}? Он пропадёт у ${server.users} пользователей.')">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="server_delete">
            <input type="hidden" name="id" value="${server.id}">
            <button class="btn danger">×</button>
          </form>
          <a class="btn" href="/admin/server?id=${server.id}" title="Настройки сервера">✎</a>
        </td>
      </tr>`;
    })
    .join("");

  const countryOptions = countries
    .map(
      (item) =>
        `<option value="${esc(item.country_code)}"${country === item.country_code ? " selected" : ""}>${esc(item.country_name || item.country_code)} (${item.n})</option>`,
    )
    .join("");

  const body = `
<h1>Серверы</h1>
<div class="sub">Статус, задержка, доступ и тарифная категория</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head">
    <h2>${total} серверов</h2><div class="spacer"></div>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="health">
      <button class="btn">Проверить пачку</button>
    </form>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="refill">
      <button class="btn">Добрать всем</button>
    </form>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="geo">
      <button class="btn">Определить страны</button>
    </form>
  </div>

  <form method="get" action="/admin/servers" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
    <input name="q" value="${esc(q)}" placeholder="поиск по адресу или метке" style="flex:1;min-width:180px">
    <select name="st">
      <option value="">любой статус</option>
      <option value="on"${st === "on" ? " selected" : ""}>ONLINE</option>
      <option value="dead"${st === "dead" ? " selected" : ""}>OFFLINE</option>
      <option value="unknown"${st === "unknown" ? " selected" : ""}>UNKNOWN</option>
      <option value="off"${st === "off" ? " selected" : ""}>выключенные</option>
    </select>
    <select name="tier">
      <option value="">любой тариф</option>
      <option value="free"${tier === "free" ? " selected" : ""}>FREE</option>
      <option value="premium"${tier === "premium" ? " selected" : ""}>PREMIUM</option>
      <option value="personal"${tier === "personal" ? " selected" : ""}>PERSONAL</option>
    </select>
    <select name="country"><option value="">все страны</option>${countryOptions}</select>
    <button class="btn primary">Показать</button>
  </form>

  <form id="bulk" method="post" action="/admin/action" style="margin-bottom:10px">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="bulk_servers">
    <select name="op">
      <option value="check">проверить выбранные</option>
      <option value="disable">выключить</option>
      <option value="enable">включить</option>
      <option value="free">тариф FREE</option>
      <option value="premium">тариф PREMIUM</option>
      <option value="delete">удалить</option>
    </select>
    <button class="btn">Применить к выбранным</button>
    <span class="muted">максимум 10 за раз</span>
  </form>

  <table>
    <thead><tr><th></th><th>Сервер</th><th>Статус</th><th>Задержка</th><th>Тариф</th><th>Людей</th><th>Проверен</th><th></th></tr></thead>
    <tbody>${body_rows || `<tr><td colspan="8" class="muted">Ничего не найдено</td></tr>`}</tbody>
  </table>

  <p class="muted" style="margin-top:10px">
    Проверка сейчас — TCP-коннект: «ONLINE» значит «порт отвечает», а не «туннель работает».
    Реальная проверка VLESS требует отдельного агента с Xray и сервера вне Cloudflare.
  </p>

  <div style="display:flex;gap:8px;margin-top:10px">
    ${pageNo > 1 ? `<a class="btn" href="/admin/servers?page=${pageNo - 1}&q=${encodeURIComponent(q)}&st=${st}&tier=${tier}&country=${country}">← Назад</a>` : ""}
    <span class="muted" style="align-self:center">страница ${pageNo} из ${pages}</span>
    ${pageNo < pages ? `<a class="btn" href="/admin/servers?page=${pageNo + 1}&q=${encodeURIComponent(q)}&st=${st}&tier=${tier}&country=${country}">Вперёд →</a>` : ""}
  </div>
</div>`;
  return page("Серверы", body, "servers", env);
}


/* ── Источники ─────────────────────────────────────────────────────────── */

async function sourcesPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const sources = await many<SourceRow & { servers_count: number }>(
    env,
    `SELECT s.*, (SELECT COUNT(*) FROM servers srv WHERE srv.source_id = s.id) AS servers_count
     FROM sources s ORDER BY s.id`,
  );
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  const slotRows = await many<{ source_id: number; n: number }>(
    env,
    "SELECT source_id, COUNT(*) AS n FROM user_sources GROUP BY source_id",
  );
  const slots = new Map(slotRows.map((row) => [row.source_id, row.n]));

  const rows = sources
    .map((source) => {
      const cls = source.status === "alive" ? "ok" : source.status === "dead" ? "bad" : "warn";
      const gb = (value: number | null) => ((value ?? 0) / GB).toFixed(1);
      const traffic = source.traffic_total
        ? `${gb(source.traffic_used)} / ${gb(source.traffic_total)} ГБ`
        : "—";
      return `<tr data-row="${esc(source.name)}">
        <td>${source.id}. ${esc(source.name)}
          <div class="muted">${esc(source.kind)} · ${esc(source.visibility)}</div>
          ${source.last_error ? `<div class="muted" style="color:#FFB454">${esc(source.last_error.slice(0, 90))}</div>` : ""}</td>
        <td><span class="pill ${cls}">${esc(source.status)}</span></td>
        <td>${esc(source.expires_at?.slice(0, 10) ?? "—")}</td>
        <td>${traffic}<div class="muted">серверов: ${source.servers_count}</div></td>
        <td>
          ${source.max_devices > 0
            ? `<b>${slots.get(source.id) ?? 0} / ${source.max_devices}</b>`
            : `<span class="muted">без лимита</span>`}
          <form method="post" action="/admin/action" style="display:flex;gap:4px;margin-top:4px">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="set_source_limit">
            <input type="hidden" name="id" value="${source.id}">
            <input name="limit" value="${source.max_devices}" inputmode="numeric"
                   style="width:56px" aria-label="Сколько устройств">
            <button class="btn">ОК</button>
          </form>
        </td>
        <td><details><summary>ссылка</summary><div class="mono">${esc(maskLink(source.url_or_link))}</div></details></td>
        <td>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="sync_source">
            <input type="hidden" name="id" value="${source.id}">
            <button class="btn">Скачать сейчас</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="preview_source">
            <input type="hidden" name="id" value="${source.id}">
            <button class="btn">Предпросмотр</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="deliver_source">
            <input type="hidden" name="id" value="${source.id}">
            <button class="btn primary">Выдать людям</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="private">
            <input type="hidden" name="id" value="${source.id}">
            <button class="btn">Приватным</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="del_source">
            <input type="hidden" name="id" value="${source.id}">
            <button class="btn danger">Удалить</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const body = `
<h1>Источники</h1>
<div class="sub">Подписки и отдельные ключи, из которых собираются серверы</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head"><h2>Добавить</h2></div>
  <form method="post" action="/admin/action" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="add_source">
    <div><label class="muted">Название</label><br><input name="name" placeholder="Мой VPS" required></div>
    <div><label class="muted">Тип</label><br>
      <select name="kind">
        <option value="own_vps">Мой VPS</option>
        <option value="trial">Триал</option>
        <option value="public">Публичная</option>
        <option value="paid_private">Платный личный</option>
      </select>
    </div>
    <div style="flex:1;min-width:240px"><label class="muted">Ссылка подписки или vless://</label><br>
      <input name="url" placeholder="https://…/sub/… или vless://…" required style="width:100%"></div>
    <button class="btn primary">Добавить</button>
  </form>
  <p class="muted" style="margin:8px 0 0">«Предпросмотр» скачивает источник и считает ключи, ничего не сохраняя.</p>
</div>

<div class="card">
  <table>
    <thead><tr><th>Название</th><th>Статус</th><th>Срок</th><th>Трафик</th><th>Слоты</th><th>Ссылка</th><th>Действия</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">Источников нет</td></tr>`}</tbody>
  </table>
</div>`;
  return page("Источники", body, "sources", env);
}

/* ── Журнал ────────────────────────────────────────────────────────────── */

async function eventsPage(env: Env): Promise<Response> {
  const events = await many<{ ts: string; type: string; user_id: number | null; details: string }>(
    env,
    "SELECT ts, type, user_id, details FROM events ORDER BY id DESC LIMIT 150",
  );
  const rows = events
    .map(
      (event) => `<tr data-row="${esc(event.type)}">
        <td class="mono">${esc(event.ts)}</td>
        <td><span class="pill">${esc(event.type)}</span></td>
        <td class="muted">${event.user_id ?? ""}</td>
        <td>${esc(event.details)}</td></tr>`,
    )
    .join("");

  const body = `<h1>События</h1><div class="sub">Что происходило в хабе</div>
    <div class="card"><table><tbody>${rows || `<tr><td class="muted">Пусто</td></tr>`}</tbody></table></div>`;
  return page("События", body, "events", env);
}

/* ── Действия ──────────────────────────────────────────────────────────── */

function countKeys(text: string): number {
  let body = text.trim();
  if (!body.includes("://")) {
    try {
      body = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    } catch {
      return 0;
    }
  }
  return body
    .split(/\r?\n/)
    .filter((line) => /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(line.trim())).length;
}

function addDays(base: Date, days: number): string {
  const next = new Date(Math.max(base.getTime(), Date.now()) + days * 86400_000);
  return next.toISOString().slice(0, 19).replace("T", " ");
}

async function handleAction(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  if (!timingSafeEqual(String(form.get("csrf") ?? ""), await csrfToken(env))) {
    return new Response("CSRF", { status: 403 });
  }

  const action = String(form.get("action") ?? "");
  const id = Number(form.get("id") ?? 0);
  const days = Number(form.get("days") ?? 0);
  const back = (path: string, ok = "", err = "") => {
    // У пути может уже быть query (?id=30) — тогда разделитель «&».
    const sep = path.includes("?") ? "&" : "?";
    const suffix = ok
      ? `${sep}ok=${encodeURIComponent(ok)}`
      : err
        ? `${sep}err=${encodeURIComponent(err)}`
        : "";
    return new Response(null, { status: 303, headers: { location: `${path}${suffix}` } });
  };

  /* ── маркетинг: настройки, промокоды, баннеры, группы ── */

  if (action === "save_settings") {
    for (const key of SETTING_KEYS) {
      const raw = form.get(key);
      if (raw === null) continue;
      await saveSetting(env, key, String(raw).slice(0, 40));
    }
    await invalidateSettings(env);
    await logEvent(env, "settings", null, "настройки бонусов обновлены");
    return back("/admin/bonuses", "Настройки сохранены");
  }

  if (action === "add_promo") {
    const rawCode = String(form.get("code") ?? "").trim();
    const code = rawCode ? normalizePromo(rawCode) : randomPromoCode();
    if (!code) return back("/admin/promos", "", "Код не подходит: только A-Z, 0-9, - и _");

    const exists = await one<{ code: string }>(env, "SELECT code FROM promos WHERE code = ?", code);
    if (exists) return back("/admin/promos", "", `Код ${code} уже существует`);

    const squad = String(form.get("squad") ?? "").trim() || null;
    const expires = String(form.get("expires") ?? "").trim();
    await run(
      env,
      `INSERT INTO promos (code, days, hours, gb, squad, squad_days, max_uses, per_user_limit, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      code,
      Math.max(0, Number(form.get("days") ?? 0)),
      Math.max(0, Number(form.get("hours") ?? 0)),
      Math.max(0, Number(form.get("gb") ?? 0)),
      squad,
      Math.max(0, Number(form.get("squad_days") ?? 0)),
      Math.max(0, Number(form.get("max_uses") ?? 0)),
      expires ? `${expires} 23:59:59` : null,
    );
    await logEvent(env, "promo_create", null, code);
    return back("/admin/promos", `Код ${code} создан`);
  }

  if (action === "toggle_promo") {
    const code = String(form.get("code") ?? "");
    await run(env, "UPDATE promos SET active = 1 - active WHERE code = ?", code);
    return back("/admin/promos", `Код ${code}: статус изменён`);
  }

  if (action === "cancel_accrual") {
    const done = await cancelAccrual(env, id);
    return done
      ? back("/admin/accruals", `Начисление #${id} отменено`)
      : back("/admin/accruals", "", "Уже отменено или не найдено");
  }

  if (action === "upload_banner") {
    const key = String(form.get("key") ?? "");
    if (!isBannerKey(key)) return back("/admin/banners", "", "Неизвестный баннер");
    const entry = form.get("file");
    if (!entry || typeof entry === "string") {
      return back("/admin/banners", "", "Файл не выбран");
    }
    const file = entry as File;
    if (!file.size) return back("/admin/banners", "", "Пустой файл");
    if (file.size > 5 * 1024 * 1024) {
      return back("/admin/banners", "", "Файл больше 5 МБ — сожмите PNG");
    }
    await saveBannerFile(env, key, await file.arrayBuffer(), file.type || "image/png");
    return back("/admin/banners", `Баннер «${BANNER_LABELS[key]}» загружен`);
  }

  if (action === "preview_banner") {
    const key = String(form.get("key") ?? "");
    if (!isBannerKey(key)) return back("/admin/banners", "", "Неизвестный баннер");
    const { sendBanner } = await import("./banners");
    const sent = await sendBanner(
      env,
      envStr(env.ADMIN_TG_ID),
      key,
      `<b>${BANNER_LABELS[key]}</b>\nПредпросмотр баннера.`,
    );
    return back(
      "/admin/banners",
      sent ? `Баннер «${BANNER_LABELS[key]}» отправлен в Telegram` : "",
      sent ? "" : "Telegram не принял файл",
    );
  }

  if (action === "reset_banner") {
    const key = String(form.get("key") ?? "");
    if (!isBannerKey(key)) return back("/admin/banners", "", "Неизвестный баннер");
    await resetBannerFile(env, key);
    return back("/admin/banners", "file_id сброшен: следующая отправка загрузит фото заново");
  }

  if (action === "webhook_info") {
    const { tgRaw } = await import("./bot/telegram");
    const info = await tgRaw<Record<string, unknown>>(env, "getWebhookInfo");
    const result = info.result ?? {};
    const parts = [
      `URL: ${String(result.url || "не задан")}`,
      `в очереди: ${String(result.pending_update_count ?? 0)}`,
      `ошибка: ${String(result.last_error_message ?? "нет")}`,
    ];
    await logEvent(env, "webhook_info", null, parts.join(" · "));
    return back("/admin/users", parts.join(" · "));
  }

  if (action === "run_notify") {
    const { runNotifications } = await import("./notify");
    const result = await runNotifications(env);
    return back(
      "/admin/bonuses",
      `Уведомлений отправлено: ${result.sent}, групп снято: ${result.squads}`,
    );
  }

  if (action === "set_squad_pool") {
    const squad = String(form.get("squad") ?? "").trim();
    const pool = String(form.get("pool") ?? "").trim();
    if (!squad) return back("/admin/squads", "", "Не указана группа");
    await saveSetting(env, `squad_pool:${squad}`, pool);
    await invalidateSettings(env);
    return back("/admin/squads", pool ? `${squad} → ${pool}` : `${squad}: привязка снята`);
  }

  if (action === "grant_squad" || action === "revoke_squad") {
    const tgId = String(form.get("tg_id") ?? "").trim();
    const squad = String(form.get("squad") ?? "").trim();
    if (!tgId || !squad) return back("/admin/squads", "", "Нужны Telegram ID и группа");
    const target = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
    if (!target) return back("/admin/squads", "", "Пользователь не найден");
    if (action === "revoke_squad") {
      await revokeSquad(env, target.id, squad);
      await logEvent(env, "squad_revoke", target.id, squad);
      return back("/admin/squads", `Группа ${squad} забрана`);
    }
    await grantSquad(env, target.id, squad, Math.max(0, Number(form.get("days") ?? 0)));
    await logEvent(env, "squad_grant", target.id, squad);
    return back("/admin/squads", `Группа ${squad} выдана`);
  }

  if (action === "update_user") {
    const user = await one<UserRow>(env, "SELECT * FROM users WHERE id = ?", id);
    if (!user) return back("/admin/users", "", "Пользователь не найден");

    const date = String(form.get("date") ?? "");
    let expires = user.expires_at;
    if (date) {
      expires = `${date} 00:00:00`;
    } else if (days !== 0) {
      const base = user.expires_at ? new Date(user.expires_at.replace(" ", "T") + "Z") : new Date();
      expires = addDays(base, days);
    }
    const traffic = Number(form.get("traffic") ?? 0);
    const devicesLimit = Math.max(1, Number(form.get("devices_limit") ?? user.device_limit));
    const pool = Number(form.get("pool") ?? 0);

    await run(
      env,
      "UPDATE users SET expires_at = ?, traffic_gb = ?, device_limit = ? WHERE id = ?",
      expires,
      Number.isFinite(traffic) ? traffic : 0,
      devicesLimit,
      id,
    );

    if (pool > 0) {
      await run(env, "DELETE FROM user_pools WHERE user_id = ?", id);
      await run(env, "INSERT OR IGNORE INTO user_pools (user_id, pool_id) VALUES (?, ?)", id, pool);
      await run(env, "DELETE FROM assignments WHERE user_id = ?", id);
    }
    await logEvent(env, "admin_update", id, `до ${expires ?? "—"}, ${traffic} ГБ, ${devicesLimit} устройств`);
    return back("/admin/users", "Сохранено");
  }

  if (action === "grant") {
    const tgId = String(form.get("tg_id") ?? "").trim();
    const user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
    if (!user) return back("/admin/users", "", "Сначала человек должен написать боту /start");
    const traffic = Number(form.get("traffic") ?? 0);
    const devicesLimit = Math.max(1, Number(form.get("devices_limit") ?? 2));
    const pool = Number(form.get("pool") ?? 0);
    const expires = addDays(new Date(), days || 30);
    await run(
      env,
      "UPDATE users SET status='active', expires_at=?, traffic_gb=?, device_limit=? WHERE id=?",
      expires,
      traffic,
      devicesLimit,
      user.id,
    );
    if (pool > 0) {
      await run(env, "DELETE FROM user_pools WHERE user_id = ?", user.id);
      await run(env, "INSERT OR IGNORE INTO user_pools (user_id, pool_id) VALUES (?, ?)", user.id, pool);
    }
    await logEvent(env, "grant", user.id, `${days || 30} дн., ${traffic} ГБ`);
    return back("/admin/users", `Выдано ${tgId} на ${days || 30} дн.`);
  }

  if (action === "ban" || action === "unban") {
    await run(
      env,
      "UPDATE users SET status = ? WHERE id = ?",
      action === "ban" ? "banned" : "active",
      id,
    );
    return back("/admin/users", action === "ban" ? "Забанен" : "Разбанен");
  }

  if (action === "set_source_limit") {
    const limit = Math.max(0, Number(form.get("limit") ?? 0));
    await run(env, "UPDATE sources SET max_devices = ? WHERE id = ?", limit, id);
    await logEvent(env, "source_limit", null, `#${id}: ${limit} устройств`);
    return back("/admin/sources", limit ? `Лимит устройств: ${limit}` : "Лимит снят");
  }

  if (action === "add_slot" || action === "del_slot") {
    const sourceId = Number(form.get("source_id") ?? 0);
    if (!sourceId) return back("/admin/users", "", "Не выбран источник");
    if (action === "del_slot") {
      await run(env, "DELETE FROM user_sources WHERE user_id = ? AND source_id = ?", id, sourceId);
      await run(
        env,
        "DELETE FROM assignments WHERE user_id = ? AND server_id IN (SELECT id FROM servers WHERE source_id = ?)",
        id,
        sourceId,
      );
      await logEvent(env, "slot_removed", id, `источник #${sourceId}`);
      return back("/admin/users", "Слот забран");
    }
    const source = await one<{ max_devices: number; name: string }>(
      env,
      "SELECT max_devices, name FROM sources WHERE id = ?",
      sourceId,
    );
    const used = await one<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM user_sources WHERE source_id = ?",
      sourceId,
    );
    if (source && source.max_devices > 0 && (used?.n ?? 0) >= source.max_devices) {
      return back("/admin/users", "", `У «${source.name}» все ${source.max_devices} слота заняты`);
    }
    await run(env, "INSERT OR IGNORE INTO user_sources (user_id, source_id) VALUES (?, ?)", id, sourceId);
    await run(
      env,
      `INSERT OR IGNORE INTO assignments (user_id, server_id)
       SELECT ?, s.id FROM servers s WHERE s.source_id = ? AND s.status = 'alive' LIMIT 3`,
      id,
      sourceId,
    );
    await logEvent(env, "slot_added", id, `источник #${sourceId}`);
    return back("/admin/users", "Слот выдан");
  }

  if (action === "selftest") {
    const adminUser = await one<UserRow>(
      env,
      "SELECT * FROM users WHERE tg_id = ?",
      envStr(env.ADMIN_TG_ID),
    );
    if (!adminUser) return back("/admin/users", "", "Нет пользователя-админа");
    const { handleSubscription } = await import("./sub");
    const response = await handleSubscription(
      env,
      adminUser.sub_token,
      new Request("https://internal/sub"),
    );
    const body = await response.text();
    let decoded = "";
    try {
      decoded = atob(body);
    } catch {
      decoded = body;
    }
    const lines = decoded.split("\n").filter((line) => line.includes("://")).length;
    return back(
      "/admin/users",
      `В вашей подписке серверов: ${lines}. userinfo: ${response.headers.get("subscription-userinfo") ?? "нет"}`,
    );
  }

  if (action === "sync_source") {
    const result = await syncOneSource(env, id);
    if (result.error) return back("/admin/sources", "", `Не скачалось: ${result.error}`);
    return back("/admin/sources", `Скачано, серверов: ${result.servers}`);
  }

  if (action === "preview_source") {
    const source = await one<SourceRow>(env, "SELECT * FROM sources WHERE id = ?", id);
    if (!source) return back("/admin/sources", "", "Источник не найден");
    if (!/^https?:\/\//i.test(source.url_or_link)) {
      return back("/admin/sources", `Одиночный ключ: ${countKeys(source.url_or_link)} ключ(ей)`);
    }
    try {
      const response = await fetch(source.url_or_link, {
        headers: { "User-Agent": env.FETCH_UA ?? "Happ/2.9.1", Accept: "*/*" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return back("/admin/sources", "", `Источник ответил HTTP ${response.status}`);
      const text = (await response.text()).slice(0, 400_000);
      const keys = countKeys(text);
      const header = response.headers.get("subscription-userinfo") ?? "нет";
      return back(
        "/admin/sources",
        `${source.name}: найдено ${keys} ключей. userinfo: ${header.slice(0, 80)}`,
      );
    } catch (error) {
      return back("/admin/sources", "", `Не скачалось: ${error instanceof Error ? error.message : "сеть"}`);
    }
  }

  if (action === "add_source") {
    const name = String(form.get("name") ?? "").trim();
    const kind = String(form.get("kind") ?? "public");
    const link = String(form.get("url") ?? "").trim();
    if (!name || !link) return back("/admin/sources", "", "Нужны название и ссылка");
    const visibility = kind === "paid_private" ? "private" : "shareable";
    await run(
      env,
      "INSERT INTO sources (name, kind, url_or_link, status, visibility) VALUES (?, ?, ?, 'unknown', ?)",
      name.slice(0, 80),
      kind,
      link,
      visibility,
    );
    const created = await one<{ id: number }>(
      env,
      "SELECT id FROM sources WHERE name = ? AND kind = ? ORDER BY id DESC LIMIT 1",
      name.slice(0, 80),
      kind,
    );
    await logEvent(env, "source_add", null, `${kind}: ${name}`);

    // Не ждём cron: сразу качаем и проверяем, чтобы человек увидел серверы.
    if (created) {
      const result = await syncOneSource(env, created.id);
      if (result.error) {
        return back("/admin/sources", "", `Источник добавлен, но не скачался: ${result.error}`);
      }
      // Новые серверы сразу раздаём людям, иначе они лежат мёртвым грузом.
      const delivered = await deliverSource(env, created.id);
      return back(
        "/admin/sources",
        `Источник «${name}» добавлен, серверов: ${result.servers}, роздано: ${delivered}`,
      );
    }
    return back("/admin/sources", `Источник «${name}» добавлен`);
  }

  if (action === "private" || action === "del_source") {
    if (action === "private") {
      await run(env, "UPDATE sources SET visibility='private' WHERE id = ?", id);
      await run(
        env,
        "DELETE FROM assignments WHERE server_id IN (SELECT id FROM servers WHERE source_id = ?)",
        id,
      );
      return back("/admin/sources", "Источник теперь приватный");
    }
    await run(env, "DELETE FROM sources WHERE id = ?", id);
    return back("/admin/sources", "Источник удалён");
  }

  if (action === "sync") {
    const { runSync } = await import("./sync");
    const result = await runSync(env);
    return back("/admin/sources", `Обновлено источников: ${result.sources}, серверов: ${result.servers}`);
  }

  if (action === "health") {
    const { runHealth } = await import("./health");
    const result = await runHealth(env);
    return back("/admin/servers", `Проверено ${result.checked}, мёртвых ${result.dead}`);
  }

  if (action === "create_invite") {
    const invite = await createInvite(env, {
      days: Number(form.get("days") ?? 30),
      gb: Number(form.get("gb") ?? 0),
      devices: Number(form.get("devices") ?? 3),
      note: String(form.get("note") ?? ""),
    });
    return back(`/admin/grant?new=${invite.code}`, "Ссылка создана");
  }

  if (action === "revoke_invite") {
    const code = String(form.get("code") ?? "");
    const done = await revokeInvite(env, code);
    return done
      ? back("/admin/grant", `Ссылка ${code} отменена`)
      : back("/admin/grant", "", "Ссылка уже использована");
  }

  if (action === "grant_user") {
    const tgId = String(form.get("tg_id") ?? "").trim().replace(/^@/, "");
    const user = await one<{ id: number }>(env, "SELECT id FROM users WHERE tg_id = ?", tgId);
    if (!user) {
      return back("/admin/grant", "", "Такого пользователя нет — отправьте ему инвайт-ссылку");
    }
    const { approveUser } = await import("./bot/user");
    await approveUser(env, user.id, Number(form.get("days") ?? 30), {
      gb: Number(form.get("gb") ?? 0),
      devices: Number(form.get("devices") ?? 3),
    });
    return back("/admin/grant", `Подписка выдана: ${tgId}`);
  }

  if (action === "deliver_source") {
    const sourceId = Number(form.get("id") ?? 0);
    const issued = await deliverSource(env, sourceId);
    return back("/admin/sources", `Выдано серверов источника: ${issued}`);
  }

  if (action === "server_save") {
    const id = Number(form.get("id") ?? 0);
    const remark = String(form.get("remark") ?? "").trim().slice(0, 80);
    const code = String(form.get("country_code") ?? "").trim().toUpperCase().slice(0, 2);
    const name = String(form.get("country_name") ?? "").trim().slice(0, 60);
    const tierRaw = String(form.get("tier") ?? "free");
    const tier = ["free", "premium", "personal"].includes(tierRaw) ? tierRaw : "free";
    const priority = Number(form.get("priority") ?? 0) || 0;
    const enabled = String(form.get("enabled")) === "0" ? 0 : 1;

    await run(
      env,
      "UPDATE servers SET remark = ?, country_code = ?, country_name = ?, tier = ?, priority = ?, enabled = ? WHERE id = ?",
      remark,
      code,
      name,
      tier,
      priority,
      enabled,
      id,
    );
    await logEvent(env, "server_save", null, `#${id} ${tier} приоритет ${priority}`);
    return back(`/admin/server?id=${id}`, "Сохранено");
  }

  if (action === "server_toggle") {
    const id = Number(form.get("id") ?? 0);
    await run(env, "UPDATE servers SET enabled = 1 - enabled WHERE id = ?", id);
    const row = await one<{ enabled: number }>(env, "SELECT enabled FROM servers WHERE id = ?", id);
    return back("/admin/servers", row?.enabled ? "Сервер включён" : "Сервер выключен");
  }

  if (action === "server_delete") {
    const id = Number(form.get("id") ?? 0);
    await run(env, "DELETE FROM assignments WHERE server_id = ?", id);
    await run(env, "DELETE FROM pool_servers WHERE server_id = ?", id);
    await run(env, "DELETE FROM server_checks WHERE server_id = ?", id);
    await run(env, "DELETE FROM servers WHERE id = ?", id);
    await logEvent(env, "server_delete", null, `id ${id}`);
    return back("/admin/servers", `Сервер #${id} удалён`);
  }

  if (action === "check_ids") {
    const ids = form
      .getAll("ids")
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .slice(0, 10);
    if (!ids.length) return back("/admin/servers", "", "Ничего не выбрано");
    const { checkServerIds } = await import("./health_manual");
    const result = await checkServerIds(env, ids);
    return back(
      "/admin/servers",
      `Проверено ${result.checked}, ответили ${result.alive}. Это TCP, туннель не проверялся.`,
    );
  }

  if (action === "bulk_servers") {
    const op = String(form.get("op") ?? "");
    const ids = [
      ...new Set(
        form
          .getAll("ids")
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    ].slice(0, 10);
    if (!ids.length) return back("/admin/servers", "", "Отметьте серверы галочками");
    const list = ids.map(() => "?").join(",");

    if (op === "check") {
      const { checkServerIds } = await import("./health_manual");
      const result = await checkServerIds(env, ids);
      return back(
        "/admin/servers",
        `Проверено ${result.checked}, ответили ${result.alive}. Это TCP, туннель не проверялся.`,
      );
    }
    if (op === "disable" || op === "enable") {
      await run(
        env,
        `UPDATE servers SET enabled = ? WHERE id IN (${list})`,
        op === "enable" ? 1 : 0,
        ...ids,
      );
      return back("/admin/servers", op === "enable" ? "Включены" : "Выключены");
    }
    if (op === "free" || op === "premium") {
      await run(env, `UPDATE servers SET tier = ? WHERE id IN (${list})`, op, ...ids);
      return back("/admin/servers", `Тариф ${op.toUpperCase()} назначен`);
    }
    if (op === "delete") {
      for (const table of ["assignments", "pool_servers", "server_checks"]) {
        await run(env, `DELETE FROM ${table} WHERE server_id IN (${list})`, ...ids);
      }
      await run(env, `DELETE FROM servers WHERE id IN (${list})`, ...ids);
      await logEvent(env, "server_bulk_delete", null, ids.join(","));
      return back("/admin/servers", `Удалено серверов: ${ids.length}`);
    }
    return back("/admin/servers", "", "Неизвестная операция");
  }

  if (action === "maintenance") {
    const { expireSubscriptions } = await import("./maintenance");
    const expired = await expireSubscriptions(env);
    return back("/admin/users", `Просроченных подписок закрыто: ${expired}`);
  }

  if (action === "geo") {
    const { fillGeo } = await import("./geo");
    let total = 0;
    for (let i = 0; i < 4; i += 1) {
      const done = await fillGeo(env, 40);
      total += done;
      if (done === 0) break;
    }
    return back("/admin/servers", `Определено стран: ${total}`);
  }

  if (action === "refill") {
    const added = await topUpAllActive(env);
    await logEvent(env, "refill", null, `добрано серверов: ${added}`);
    return back("/admin/servers", `Добрано серверов: ${added}`);
  }

  if (action === "rebalance") {
    const moves = await rebalance(env);
    return back("/admin/servers", `Перераспределено: ${moves}`);
  }

  if (action === "webhook") {
    const target = `${envStr(env.PUBLIC_BASE_URL).replace(/\/$/, "")}/webhook`;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${envStr(env.BOT_TOKEN)}/setWebhook`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: target, secret_token: envStr(env.WEBHOOK_SECRET) }),
        },
      );
      const data = (await response.json()) as { ok?: boolean; description?: string };
      return back("/admin/users", data.ok ? "Вебхук установлен" : "", data.description ?? "Ошибка");
    } catch (error) {
      return back("/admin/users", "", `Не удалось: ${error instanceof Error ? error.message : "сеть"}`);
    }
  }

  if (action === "menu" || action === "ping") {
    const { sendMessage } = await import("./bot/telegram");
    const { sendMenu } = await import("./bot/user");
    const chat = envStr(env.ADMIN_TG_ID);
    if (action === "menu") {
      await sendMenu(env, chat);
      return back("/admin/users", "Меню отправлено в Telegram");
    }
    const sent = await sendMessage(env, chat, "<b>VPN Hub</b>: связь с ботом есть.");
    return back("/admin/users", sent ? "Сообщение доставлено" : "", sent ? "" : "Telegram не принял");
  }

  if (action === "diag") {
    const { tgRaw } = await import("./bot/telegram");
    const me = await tgRaw<{ username?: string }>(env, "getMe");
    const info = await tgRaw<{ url?: string; pending_update_count?: number }>(env, "getWebhookInfo");
    await tgRaw(env, "deleteWebhook", { drop_pending_updates: false });
    const updates = await tgRaw<unknown[]>(env, "getUpdates", { timeout: 0, limit: 5 });
    const summary = `бот: ${me.result?.username ?? "нет"}; вебхук: ${info.result?.url ?? "нет"}; ` +
      `в очереди: ${info.result?.pending_update_count ?? 0}; обновлений: ${Array.isArray(updates.result) ? updates.result.length : 0}`;
    await logEvent(env, "tg_diag", null, summary);
    return back("/admin/users", summary);
  }

  if (action === "poll") {
    const { runPoll } = await import("./polling");
    const processed = await runPoll(env);
    return back("/admin/users", `Новых обновлений: ${processed}`);
  }

  return back("/admin/users", "", "Неизвестное действие");
}

/* ══════════════════════════════════════════════════════════════════════════
   Маркетинг: настройки бонусов, промокоды, журнал начислений, баннеры, группы
   ══════════════════════════════════════════════════════════════════════════ */

const SETTING_KEYS = [
  "daily_enabled",
  "daily_bonus_hours",
  "daily_streak3_hours",
  "daily_streak7_hours",
  "daily_month_cap_hours",
  "referral_enabled",
  "referral_reward_days",
  "referral_reward_inviter",
  "referral_month_cap_days",
  "channel_reward_days",
  "promo_enabled",
  "squads_enabled",
  "notify_expiring",
  "notify_days_before",
  "notify_comeback",
  "comeback_days",
  "clicker_enabled",
  "clicker_daily_cap_hours",
];

function settingField(key: string, label: string, value: string, hint = ""): string {
  return `<div>
    <label class="muted">${esc(label)}</label><br>
    <input name="${key}" value="${esc(value)}" inputmode="decimal" style="width:120px">
    ${hint ? `<div class="muted" style="font-size:12px">${esc(hint)}</div>` : ""}
  </div>`;
}

function settingToggle(key: string, label: string, value: string): string {
  return `<div>
    <label class="muted">${esc(label)}</label><br>
    <select name="${key}">
      <option value="1"${value === "1" ? " selected" : ""}>вкл</option>
      <option value="0"${value === "1" ? "" : " selected"}>выкл</option>
    </select>
  </div>`;
}

async function bonusesPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const settings = await loadSettings(env);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  const value = (key: string, fallback = "") => settings[key] ?? fallback;

  const body = `
<h1>Настройки бонусов</h1>
<div class="sub">Все числа правятся здесь и действуют сразу, без деплоя</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<form method="post" action="/admin/action">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="save_settings">

  <div class="card">
    <div class="head"><h2>Ежедневный бонус</h2></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
      ${settingToggle("daily_enabled", "Бонус дня", value("daily_enabled", "1"))}
      ${settingField("daily_bonus_hours", "Часов за день", value("daily_bonus_hours", "1"))}
      ${settingField("daily_streak3_hours", "Часов на 3-й день", value("daily_streak3_hours", "2"))}
      ${settingField("daily_streak7_hours", "Часов на 7-й день", value("daily_streak7_hours", "3"))}
      ${settingField("daily_month_cap_hours", "Потолок в месяц, ч", value("daily_month_cap_hours", "48"))}
    </div>
    <p class="muted" style="margin:10px 0 0">Сутки считаются по Москве, сброс в 00:00.</p>
  </div>

  <div class="card">
    <div class="head"><h2>Рефералы и канал</h2></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
      ${settingToggle("referral_enabled", "Реферальная программа", value("referral_enabled", "1"))}
      ${settingToggle("referral_reward_inviter", "Награждать пригласившего", value("referral_reward_inviter", "1"))}
      ${settingField("referral_reward_days", "Дней за друга", value("referral_reward_days", "1"))}
      ${settingField("referral_month_cap_days", "Потолок дней в месяц", value("referral_month_cap_days", "30"))}
      ${settingField("channel_reward_days", "Дней за подписку на канал", value("channel_reward_days", "1"))}
    </div>
  </div>

  <div class="card">
    <div class="head"><h2>Уведомления и группы</h2></div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
      ${settingToggle("notify_expiring", "Напоминать о конце срока", value("notify_expiring", "1"))}
      ${settingField("notify_days_before", "За сколько дней", value("notify_days_before", "1"))}
      ${settingToggle("notify_comeback", "Возврат после истечения", value("notify_comeback", "1"))}
      ${settingField("comeback_days", "Через сколько дней", value("comeback_days", "3"))}
      ${settingToggle("squads_enabled", "Группы (Bypass)", value("squads_enabled", "0"))}
      ${settingToggle("promo_enabled", "Промокоды", value("promo_enabled", "1"))}
      ${settingToggle("clicker_enabled", "Кликер (Mini App)", value("clicker_enabled", "0"))}
    </div>
  </div>

  <button class="btn primary" type="submit">Сохранить настройки</button>
</form>

<form method="post" action="/admin/action" style="margin-top:10px">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="run_notify">
  <button class="btn">Прогнать уведомления сейчас</button>
  <span class="muted">проверит сроки и отправит напоминания, не дожидаясь cron</span>
</form>`;

  return page("Настройки бонусов", body, "bonuses", env);
}

async function promosPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  const promos = await many<{
    code: string;
    days: number;
    hours: number;
    gb: number;
    squad: string | null;
    squad_days: number;
    max_uses: number;
    used: number;
    expires_at: string | null;
    active: number;
  }>(env, "SELECT * FROM promos ORDER BY created_at DESC LIMIT 200");

  const rows = promos
    .map((promo) => {
      const reward = [
        promo.days ? `${promo.days} дн.` : "",
        promo.hours ? `${promo.hours} ч` : "",
        promo.gb ? `${promo.gb} ГБ` : "",
        promo.squad ? `${esc(promo.squad)} на ${promo.squad_days} дн.` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<tr data-row="${esc(promo.code)}">
        <td class="mono">${esc(promo.code)}</td>
        <td>${reward || "—"}</td>
        <td>${promo.used}${promo.max_uses ? ` / ${promo.max_uses}` : ""}</td>
        <td>${esc(promo.expires_at?.slice(0, 10) ?? "бессрочно")}</td>
        <td><span class="pill ${promo.active ? "ok" : "bad"}">${promo.active ? "активен" : "выкл"}</span></td>
        <td>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="toggle_promo">
            <input type="hidden" name="code" value="${esc(promo.code)}">
            <button class="btn">${promo.active ? "Выключить" : "Включить"}</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const body = `
<h1>Промокоды</h1>
<div class="sub">Дни, гигабайты и группа Bypass. Активация — /promo КОД в боте</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head"><h2>Новый код</h2></div>
  <form method="post" action="/admin/action" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="add_promo">
    <div><label class="muted">Код (пусто — сгенерируем)</label><br><input name="code" placeholder="ORANGE2026" style="width:150px"></div>
    <div><label class="muted">Дней</label><br><input name="days" value="7" inputmode="numeric" style="width:80px"></div>
    <div><label class="muted">Часов</label><br><input name="hours" value="0" inputmode="numeric" style="width:80px"></div>
    <div><label class="muted">ГБ</label><br><input name="gb" value="0" inputmode="numeric" style="width:80px"></div>
    <div><label class="muted">Группа</label><br>
      <select name="squad">
        <option value="">нет</option>
        ${SQUADS.map((squad) => `<option value="${squad}">${squad}</option>`).join("")}
      </select>
    </div>
    <div><label class="muted">Дней группы</label><br><input name="squad_days" value="0" inputmode="numeric" style="width:90px"></div>
    <div><label class="muted">Лимит активаций (0 — без)</label><br><input name="max_uses" value="0" inputmode="numeric" style="width:120px"></div>
    <div><label class="muted">Действует до</label><br><input type="date" name="expires"></div>
    <button class="btn primary">Создать</button>
  </form>
</div>

<div class="card">
  <table>
    <thead><tr><th>Код</th><th>Награда</th><th>Активаций</th><th>До</th><th>Статус</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">Пока нет кодов</td></tr>`}</tbody>
  </table>
</div>`;

  return page("Промокоды", body, "promos", env);
}

async function accrualsPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const userId = Number(url.searchParams.get("user") ?? 0);
  const ok = url.searchParams.get("ok");

  const rowsData = await many<{
    id: number;
    user_id: number;
    tg_id: string;
    kind: string;
    hours: number;
    gb: number;
    note: string;
    status: string;
    created_at: string;
  }>(
    env,
    `SELECT a.id, a.user_id, u.tg_id, a.kind, a.hours, a.gb, a.note, a.status, a.created_at
       FROM accruals a JOIN users u ON u.id = a.user_id
      ${userId ? "WHERE a.user_id = ?" : ""}
      ORDER BY a.id DESC LIMIT 200`,
    ...(userId ? [userId] : []),
  );

  const rows = rowsData
    .map(
      (row) => `<tr data-row="${esc(row.tg_id)} ${esc(row.kind)}">
      <td class="mono">${row.id}</td>
      <td>${esc(row.tg_id)}</td>
      <td>${esc(row.kind)}</td>
      <td>${row.hours ? `+${row.hours} ч` : ""}${row.gb ? ` +${row.gb} ГБ` : ""}</td>
      <td class="muted">${esc(row.note)}</td>
      <td>${esc(row.created_at)}</td>
      <td><span class="pill ${row.status === "applied" ? "ok" : "bad"}">${esc(row.status)}</span></td>
      <td>${
        row.status === "applied"
          ? `<form method="post" action="/admin/action" class="inline">
               <input type="hidden" name="csrf" value="${csrf}">
               <input type="hidden" name="action" value="cancel_accrual">
               <input type="hidden" name="id" value="${row.id}">
               <button class="btn danger">Отменить</button>
             </form>`
          : "—"
      }</td>
    </tr>`,
    )
    .join("");

  const body = `
<h1>Начисления</h1>
<div class="sub">Единый журнал: бонусы, рефералы, промокоды, канал${userId ? ` · фильтр по пользователю #${userId}` : ""}</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
<div class="card">
  <table>
    <thead><tr><th>#</th><th>Кто</th><th>Тип</th><th>Начислено</th><th>Комментарий</th><th>Когда</th><th>Статус</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="8" class="muted">Начислений пока нет</td></tr>`}</tbody>
  </table>
</div>`;

  return page("Начисления", body, "accruals", env);
}

async function bannersPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  const rows = await many<{ key: string; file_id: string; updated_at: string }>(
    env,
    "SELECT key, file_id, updated_at FROM banners",
  );
  const byKey = new Map(rows.map((row) => [row.key, row]));

  const cards = BANNER_KEYS.map((key) => {
    const row = byKey.get(key);
    const ready = Boolean(row?.file_id);
    return `<div class="card" style="min-width:280px">
      <div class="head"><h2 style="font-size:15px">${esc(BANNER_LABELS[key])}</h2></div>
      <img src="/admin/banner-file/${key}?v=${encodeURIComponent(row?.updated_at ?? "")}"
           alt="${key}" style="width:100%;border-radius:10px;display:block;background:#0f1115">
      <div class="muted" style="margin:6px 0">
        ${ready ? "file_id сохранён — отправляется без повторной загрузки" : "файл ещё не загружен"}
      </div>
      <form method="post" action="/admin/action" enctype="multipart/form-data" style="display:grid;gap:6px">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="action" value="upload_banner">
        <input type="hidden" name="key" value="${key}">
        <input type="file" name="file" accept="image/png,image/jpeg,image/webp" required>
        <button class="btn primary">Загрузить PNG</button>
      </form>
      <form method="post" action="/admin/action" style="margin-top:6px">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="action" value="reset_banner">
        <input type="hidden" name="key" value="${key}">
        <button class="btn">Сбросить file_id</button>
      </form>
      <form method="post" action="/admin/action" style="margin-top:6px">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="action" value="preview_banner">
        <input type="hidden" name="key" value="${key}">
        <button class="btn">Проверить в Telegram</button>
      </form>
    </div>`;
  }).join("");

  const body = `
<h1>Баннеры</h1>
<div class="sub">1280×720 PNG. Каждый экран бота отправляется фото с подписью</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}
<div style="display:flex;gap:14px;flex-wrap:wrap">${cards}</div>`;

  return page("Баннеры", body, "banners", env);
}

async function bannerFileResponse(env: Env, rawKey: string): Promise<Response> {
  const key = decodeURIComponent(rawKey).replace(/\?.*$/, "");
  if (!isBannerKey(key)) return new Response("Не найдено", { status: 404 });
  const bytes = await env.CACHE.get(`banner:${key}`, "arrayBuffer");
  if (!bytes) return new Response("Файл не загружен", { status: 404 });
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=60" },
  });
}

async function squadsPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");

  const pools = await many<{ id: number; name: string; servers: number; users: number }>(
    env,
    `SELECT p.id, p.name,
       (SELECT COUNT(*) FROM pool_servers ps WHERE ps.pool_id = p.id) AS servers,
       (SELECT COUNT(*) FROM user_pools up WHERE up.pool_id = p.id) AS users
     FROM pools p ORDER BY p.id`,
  );

  const assigned = await many<{ user_id: number; tg_id: string; squad: string; expires_at: string | null }>(
    env,
    `SELECT us.user_id, u.tg_id, us.squad, us.expires_at
       FROM user_squads us JOIN users u ON u.id = us.user_id
      ORDER BY us.created_at DESC LIMIT 100`,
  );

  const poolRows = pools
    .map(
      (pool) => `<tr data-row="${esc(pool.name)}">
      <td>${esc(pool.name)}</td>
      <td>${pool.servers}</td>
      <td>${pool.users}</td>
    </tr>`,
    )
    .join("");

  const assignedRows = assigned
    .map(
      (row) => `<tr data-row="${esc(row.tg_id)} ${esc(row.squad)}">
      <td>${esc(row.tg_id)}</td>
      <td>${esc(row.squad)}</td>
      <td>${esc(row.expires_at?.slice(0, 10) ?? "бессрочно")}</td>
      <td>
        <form method="post" action="/admin/action" class="inline">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="action" value="revoke_squad">
          <input type="hidden" name="tg_id" value="${esc(row.tg_id)}">
          <input type="hidden" name="squad" value="${esc(row.squad)}">
          <button class="btn danger">Забрать</button>
        </form>
      </td>
    </tr>`,
    )
    .join("");

  const settings = await loadSettings(env);
  const mapping = SQUADS.map((squad) => {
    const current = settings[`squad_pool:${squad}`] ?? "";
    return `<form method="post" action="/admin/action" class="inline" style="display:inline-flex;gap:8px;align-items:center;margin-right:16px">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="set_squad_pool">
      <input type="hidden" name="squad" value="${squad}">
      <b>${squad}</b> →
      <select name="pool">
        <option value="">не привязан</option>
        ${pools
          .map(
            (pool) =>
              `<option value="${esc(pool.name)}"${current === pool.name ? " selected" : ""}>${esc(pool.name)}</option>`,
          )
          .join("")}
      </select>
      <button class="btn">Сохранить</button>
    </form>`;
  }).join("");

  const body = `
<h1>Группы серверов</h1>
<div class="sub">Default — обычные серверы, Bypass — обход белых списков</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head"><h2>Пулы</h2></div>
  <table>
    <thead><tr><th>Группа</th><th>Серверов</th><th>Пользователей</th></tr></thead>
    <tbody>${poolRows || `<tr><td colspan="3" class="muted">Пулов нет</td></tr>`}</tbody>
  </table>
</div>

<div class="card">
  <div class="head"><h2>Привязка групп к пулам</h2></div>
  <p class="muted" style="margin-top:0">Bypass должен вести на пул с серверами для белых списков, Default — на обычный.</p>
  ${mapping}
</div>

<div class="card">
  <div class="head"><h2>Выдать группу</h2></div>
  <form method="post" action="/admin/action" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="grant_squad">
    <div><label class="muted">Telegram ID</label><br><input name="tg_id" placeholder="5680608085" required></div>
    <div><label class="muted">Группа</label><br>
      <select name="squad">${SQUADS.map((squad) => `<option value="${squad}">${squad}</option>`).join("")}</select>
    </div>
    <div><label class="muted">Дней (0 — бессрочно)</label><br><input name="days" value="0" inputmode="numeric" style="width:120px"></div>
    <button class="btn primary">Выдать</button>
  </form>
</div>

<div class="card">
  <div class="head"><h2>Кому выдано</h2></div>
  <table>
    <thead><tr><th>Кто</th><th>Группа</th><th>До</th><th></th></tr></thead>
    <tbody>${assignedRows || `<tr><td colspan="4" class="muted">Пока никому</td></tr>`}</tbody>
  </table>
</div>`;

  return page("Группы", body, "squads", env);
}

/* ══════════════════════════════════════════════════════════════════════════
   Выдача подписок: инвайт-ссылки и прямое одобрение по Telegram ID
   ══════════════════════════════════════════════════════════════════════════ */

async function grantPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const fresh = url.searchParams.get("new");
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  const invites = await listInvites(env);

  const freshBlock = fresh
    ? `<div class="card" style="border-color:#4FE3C1">
         <div class="head"><h2>Ссылка готова</h2></div>
         <p class="muted" style="margin-top:0">Отправьте её человеку. Сгорает после первого входа.</p>
         <p class="mono" style="font-size:15px;word-break:break-all">${esc(inviteLink(env, fresh))}</p>
       </div>`
    : "";

  const rows = invites
    .map((invite) => {
      const used = invite.used_by !== null;
      return `<tr data-row="${esc(invite.code)}">
        <td class="mono">${esc(invite.code)}</td>
        <td>${invite.days} дн.</td>
        <td>${invite.gb ? `${invite.gb} ГБ` : "без лимита"}</td>
        <td>${invite.devices}</td>
        <td>${used ? `<span class="pill ok">использован</span>` : `<span class="pill warn">свободен</span>`}</td>
        <td>${used ? "—" : `<span class="mono" style="font-size:12px">${esc(inviteLink(env, invite.code))}</span>`}</td>
        <td>${
          used
            ? "—"
            : `<form method="post" action="/admin/action" class="inline">
                 <input type="hidden" name="csrf" value="${csrf}">
                 <input type="hidden" name="action" value="revoke_invite">
                 <input type="hidden" name="code" value="${esc(invite.code)}">
                 <button class="btn danger">Отменить</button>
               </form>`
        }</td>
      </tr>`;
    })
    .join("");

  const body = `
<h1>Выдать подписку</h1>
<div class="sub">Инвайт-ссылка или прямое одобрение по Telegram ID</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}
${freshBlock}

<div class="card">
  <div class="head"><h2>Новая ссылка-приглашение</h2></div>
  <form method="post" action="/admin/action" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="create_invite">
    <div><label class="muted">Дней</label><br><input name="days" value="30" inputmode="numeric" style="width:90px"></div>
    <div><label class="muted">ГБ (0 — без лимита)</label><br><input name="gb" value="0" inputmode="numeric" style="width:120px"></div>
    <div><label class="muted">Устройств</label><br><input name="devices" value="3" inputmode="numeric" style="width:100px"></div>
    <div><label class="muted">Пометка</label><br><input name="note" placeholder="для кого" style="width:180px"></div>
    <button class="btn primary">Создать ссылку</button>
  </form>
</div>

<div class="card">
  <div class="head"><h2>Выдать существующему</h2></div>
  <p class="muted" style="margin-top:0">Человек уже запускал бота — знаете его Telegram ID.</p>
  <form method="post" action="/admin/action" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="grant_user">
    <div><label class="muted">Telegram ID</label><br><input name="tg_id" placeholder="123456789" style="width:150px"></div>
    <div><label class="muted">Дней</label><br><input name="days" value="30" inputmode="numeric" style="width:90px"></div>
    <div><label class="muted">ГБ (0 — без лимита)</label><br><input name="gb" value="0" inputmode="numeric" style="width:120px"></div>
    <div><label class="muted">Устройств</label><br><input name="devices" value="3" inputmode="numeric" style="width:100px"></div>
    <button class="btn primary">Выдать</button>
  </form>
</div>

<div class="card">
  <div class="head"><h2>Ссылки</h2></div>
  <table>
    <thead><tr><th>Код</th><th>Срок</th><th>Трафик</th><th>Устройств</th><th>Статус</th><th>Ссылка</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">Пока нет ссылок</td></tr>`}</tbody>
  </table>
</div>`;

  return page("Выдать подписку", body, "grant", env);
}

/* ══════════════════════════════════════════════════════════════════════════
   Карточка сервера: имя, страна, тариф, приоритет, история проверок
   ══════════════════════════════════════════════════════════════════════════ */

async function serverEditPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const id = Number(url.searchParams.get("id") ?? 0);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");

  const server = await one<{
    id: number;
    host: string;
    port: number;
    remark: string;
    status: string;
    enabled: number;
    tier: string;
    priority: number;
    country_code: string | null;
    country_name: string | null;
    city: string | null;
    latency_ms: number | null;
    last_check_at: string | null;
    link: string;
  }>(env, "SELECT * FROM servers WHERE id = ?", id);

  if (!server) {
    return page("Сервер не найден", `<div class="card"><p>Сервер #${id} не существует.</p>
      <a class="btn" href="/admin/servers">← К списку</a></div>`, "servers", env);
  }

  const checks = await many<{ checked_at: string; result: string; latency_ms: number | null; error: string | null }>(
    env,
    "SELECT checked_at, result, latency_ms, error FROM server_checks WHERE server_id = ? ORDER BY id DESC LIMIT 12",
    id,
  );
  const users = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM assignments WHERE server_id = ?",
    id,
  );

  const checkRows = checks
    .map(
      (check) =>
        `<tr><td class="muted">${esc(check.checked_at)}</td>
         <td>${check.result === "ok" ? `<span class="pill ok">ok</span>` : `<span class="pill bad">fail</span>`}</td>
         <td>${check.latency_ms ?? "—"} мс</td>
         <td class="muted">${esc(check.error ?? "")}</td></tr>`,
    )
    .join("");

  const body = `
<h1>Сервер #${server.id}</h1>
<div class="sub mono">${esc(server.host)}:${server.port} · выдано людям: ${users?.n ?? 0}</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head"><h2>Настройки</h2></div>
  <form method="post" action="/admin/action" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="server_save">
    <input type="hidden" name="id" value="${server.id}">
    <div style="flex:1;min-width:220px">
      <label class="muted">Название для пользователя</label><br>
      <input name="remark" value="${esc(server.remark)}" style="width:100%">
    </div>
    <div><label class="muted">Код страны</label><br>
      <input name="country_code" value="${esc(server.country_code ?? "")}" maxlength="2" style="width:70px"></div>
    <div><label class="muted">Страна</label><br>
      <input name="country_name" value="${esc(server.country_name ?? "")}" style="width:150px"></div>
    <div><label class="muted">Тариф</label><br>
      <select name="tier">
        ${["free", "premium", "personal"].map((t) => `<option value="${t}"${server.tier === t ? " selected" : ""}>${t.toUpperCase()}</option>`).join("")}
      </select></div>
    <div><label class="muted">Приоритет</label><br>
      <input name="priority" value="${server.priority}" inputmode="numeric" style="width:90px"></div>
    <div><label class="muted">Состояние</label><br>
      <select name="enabled">
        <option value="1"${server.enabled ? " selected" : ""}>включён</option>
        <option value="0"${server.enabled ? "" : " selected"}>выключен</option>
      </select></div>
    <button class="btn primary">Сохранить</button>
  </form>
  <p class="muted" style="margin:10px 0 0">
    Название показывается в подписке как есть, если заполнено. Пусто — имя соберётся
    из протокола и страны. Приоритет выше нуля поднимает сервер в начало списка.
  </p>
</div>

<div class="card">
  <div class="head"><h2>История проверок</h2></div>
  <table>
    <thead><tr><th>Когда</th><th>Результат</th><th>Задержка</th><th>Ошибка</th></tr></thead>
    <tbody>${checkRows || `<tr><td colspan="4" class="muted">Проверок ещё не было</td></tr>`}</tbody>
  </table>
  <p class="muted" style="margin-top:10px">Проверка — TCP-коннект к порту. Туннель VLESS не проверяется.</p>
</div>

<a class="btn" href="/admin/servers">← К списку серверов</a>`;

  return page(`Сервер #${server.id}`, body, "servers", env);
}
