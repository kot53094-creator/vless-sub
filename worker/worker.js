/**
 * Апельсинка VPN — посредник подписки и учёт устройств.
 *
 * Cloudflare Workers, бесплатный тариф. Один файл, без сборки.
 *
 *   GET  /s/<device>          выдать подписку и записать устройство
 *   GET  /api/stats           публичная статистика для dashboard.html
 *   GET  /admin               страница управления устройствами
 *   GET  /api/admin/devices   список устройств (нужен ключ администратора)
 *   POST /api/admin/block     отвязать / вернуть устройство (нужен ключ)
 *
 * Ключ администратора лежит в секрете worker'а (ADMIN_KEY), не в коде.
 * Отвязка действует на этот посредник: заблокированная метка получает 403.
 * Слоты у провайдера (например «макс 3 устройства») так не освобождаются —
 * для этого нужно менять токен в панели провайдера.
 */

const SOURCE = "https://kot53094-creator.github.io/vless-sub/sub-ru.txt";
const TITLE = "Апельсинка впн";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-admin-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });
}

async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

function isAdmin(request, env) {
  const header = request.headers.get("x-admin-key") || "";
  return Boolean(env.ADMIN_KEY) && header === env.ADMIN_KEY;
}

async function readDevice(env, device) {
  return (await env.STATS.get(`dev:${device}`, "json")) || null;
}

async function logHit(env, device, request) {
  const now = new Date().toISOString();
  const prev = await readDevice(env, device);
  const record = {
    device,
    first_seen: prev?.first_seen || now,
    last_seen: now,
    hits: (prev?.hits || 0) + 1,
    country: request.cf?.country || prev?.country || "",
    client: (request.headers.get("user-agent") || "").slice(0, 60),
    blocked: prev?.blocked || false,
    ip_hash: await sha1((request.headers.get("cf-connecting-ip") || "") + "apelsinka"),
  };
  await env.STATS.put(`dev:${device}`, JSON.stringify(record));

  const day = now.slice(0, 10);
  const dayKey = `day:${day}`;
  const dayCount = parseInt((await env.STATS.get(dayKey)) || "0", 10) + 1;
  await env.STATS.put(dayKey, String(dayCount));
}

const ADMIN_PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Апельсинка VPN — управление</title>
<style>
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;background:#fdfaf7;color:#1c1917}
.wrap{max-width:720px;margin:0 auto;padding:32px 18px 60px}
h1{font-size:24px;margin:0 0 6px}
p.lead{color:#78716c;font-size:14px;margin:0 0 20px}
input{font:inherit;padding:10px 12px;border:1px solid #fed7aa;border-radius:10px;width:100%;box-sizing:border-box}
button{font:inherit;border:0;border-radius:10px;padding:10px 16px;background:#f97316;color:#fff;
font-weight:600;cursor:pointer;margin-top:10px}
button.sec{background:#fff;color:#f97316;border:1px solid #fdba74}
.card{background:#fff;border:1px solid #ffedd5;border-radius:14px;padding:14px 16px;margin-bottom:10px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.name{font-weight:700}
.muted{color:#78716c;font-size:13px}
.bad{color:#b91c1c;font-size:12px;font-weight:600}
.ok{color:#047857;font-size:12px;font-weight:600}
#gate{margin-bottom:18px}
</style></head><body><div class="wrap">
<h1>Управление устройствами</h1>
<p class="lead">Отвязка действует на этот посредник: заблокированная метка получает 403 и не забирает подписку.
Слоты у провайдера так не освобождаются — для этого меняйте токен в панели провайдера.</p>
<div id="gate">
  <input id="key" type="password" placeholder="Ключ администратора">
  <button onclick="saveKey()">Войти</button>
</div>
<div id="list"></div>
<script>
let KEY = localStorage.getItem("apelsinka_admin") || "";
document.getElementById("key").value = KEY;
function saveKey(){ KEY = document.getElementById("key").value.trim();
  localStorage.setItem("apelsinka_admin", KEY); load(); }
async function api(path, opts){
  const r = await fetch(path, {...opts, headers:{"x-admin-key":KEY, "content-type":"application/json"}});
  if(!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
function fmt(iso){ return iso ? new Date(iso).toLocaleString("ru-RU") : "—"; }
async function load(){
  const box = document.getElementById("list");
  try{
    const data = await api("/api/admin/devices");
    if(!data.devices.length){ box.innerHTML = '<div class="card muted">Устройств пока нет.</div>'; return; }
    box.innerHTML = data.devices.map(d => \`
      <div class="card"><div class="row">
        <div><div class="name">\${d.device}</div>
          <div class="muted">последний раз: \${fmt(d.last_seen)} · запросов: \${d.hits} · \${d.country || "—"}</div>
          <div class="\${d.blocked ? "bad" : "ok"}">\${d.blocked ? "отвязано" : "активно"}</div></div>
        <button class="\${d.blocked ? "sec" : ""}" onclick="toggle('\${d.device}', \${!d.blocked})">
          \${d.blocked ? "вернуть" : "отвязать"}</button>
      </div></div>\`).join("");
  }catch(e){ box.innerHTML = '<div class="card bad">Не удалось загрузить: ' + e.message + '</div>'; }
}
async function toggle(device, blocked){
  await api("/api/admin/block", {method:"POST", body: JSON.stringify({device, blocked})});
  load();
}
if(KEY) load();
</script></div></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/admin") {
      return new Response(ADMIN_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ ok: true, service: "apelsinka-vpn", source: SOURCE });
    }

    if (url.pathname === "/api/stats") {
      const list = await env.STATS.list({ prefix: "dev:" });
      const devices = [];
      for (const key of list.keys) {
        const value = await env.STATS.get(key.name, "json");
        if (value) {
          devices.push({
            device: value.device, first_seen: value.first_seen, last_seen: value.last_seen,
            hits: value.hits, country: value.country, client: value.client,
            blocked: Boolean(value.blocked),
          });
        }
      }
      devices.sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
      return json({ devices, updated: new Date().toISOString() });
    }

    if (url.pathname === "/api/admin/devices") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      const list = await env.STATS.list({ prefix: "dev:" });
      const devices = [];
      for (const key of list.keys) {
        const value = await env.STATS.get(key.name, "json");
        if (value) devices.push(value);
      }
      devices.sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
      return json({ devices });
    }

    if (url.pathname === "/api/admin/block" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      const body = await request.json().catch(() => ({}));
      const device = String(body.device || "").toLowerCase().slice(0, 32);
      if (!/^[a-z0-9_-]{1,32}$/.test(device)) return json({ error: "bad device" }, 400);
      const record = await readDevice(env, device);
      if (!record) return json({ error: "unknown device" }, 404);
      record.blocked = Boolean(body.blocked);
      await env.STATS.put(`dev:${device}`, JSON.stringify(record));
      return json({ ok: true, device, blocked: record.blocked });
    }

    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,32})$/);
    if (match) {
      const device = match[1].toLowerCase();
      const known = await readDevice(env, device);
      if (known && known.blocked) {
        return new Response("This device was unlinked.", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const upstream = await fetch(SOURCE, {
        cf: { cacheTtl: 60, cacheEverything: true },
        headers: { "user-agent": request.headers.get("user-agent") || "v2rayNG" },
      });
      const body = await upstream.text();
      if (upstream.ok) {
        await logHit(env, device, request).catch(() => {});
      }
      return new Response(body, {
        status: upstream.status,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "profile-title": "base64:" + btoa(unescape(encodeURIComponent(TITLE))),
          "profile-update-interval": "6",
          "cache-control": "no-store",
        },
      });
    }

    return json({ error: "not found", hint: "use /s/<device>" }, 404);
  },
};
