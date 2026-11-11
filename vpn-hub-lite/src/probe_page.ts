/**
 * Живая проверка «включён ли VPN сейчас» — открывается с телефона или ПК.
 *
 * Страница каждый раз заново смотрит, с какого IP пришёл запрос, и сравнивает
 * его с выходами наших узлов. Пока человек на странице, она опрашивает
 * /p/<токен>/state и обновляет индикатор — можно включить VPN и увидеть,
 * как через пару секунд статус станет зелёным.
 */

import { one } from "./db";
import { BRAND } from "./brand";
import { humanAge, recordPresence, snapshot, FRESH_SECONDS } from "./presence";
import type { Env, UserRow } from "./types";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const COUNTRY_RU: Record<string, string> = {
  DE: "Германия", NL: "Нидерланды", FI: "Финляндия", FR: "Франция", US: "США",
  GB: "Великобритания", SE: "Швеция", PL: "Польша", CA: "Канада", SG: "Сингапур",
  JP: "Япония", TR: "Турция", RU: "Россия", LV: "Латвия", LT: "Литва",
  EE: "Эстония", CH: "Швейцария", AT: "Австрия", CZ: "Чехия", RO: "Румыния",
  IT: "Италия", ES: "Испания", HK: "Гонконг", KZ: "Казахстан", AE: "ОАЭ",
  IN: "Индия", BR: "Бразилия", AU: "Австралия",
};

function countryName(code: string): string {
  const value = (code ?? "").toUpperCase();
  return COUNTRY_RU[value] ?? value ?? "";
}

function shell(title: string, body: string): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${BRAND}</title>
<style>
:root{--bg:#0b0d12;--panel:#141821;--line:#232937;--text:#eef3fb;--muted:#8d99ad;
--ok:#3ddc97;--off:#ff7a59;--accent:#ff8a3d}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;
background:radial-gradient(1000px 600px at 50% -10%,#1b2233 0%,var(--bg) 60%),var(--bg);
color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{width:100%;max-width:440px}
.brand{display:flex;align-items:center;gap:9px;justify-content:center;margin-bottom:18px;
font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.brand i{width:22px;height:22px;border-radius:7px;background:linear-gradient(140deg,#ffa95c,#ff6a2b);
display:grid;place-items:center;font-style:normal;font-size:11px;color:#2a1200;font-weight:800;letter-spacing:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:26px;text-align:center}
.dot{width:78px;height:78px;margin:4px auto 16px;border-radius:50%;display:grid;place-items:center;
font-size:30px;border:2px solid var(--line);transition:.25s}
.dot.on{border-color:var(--ok);background:rgba(61,220,151,.12);box-shadow:0 0 0 8px rgba(61,220,151,.06)}
.dot.off{border-color:var(--off);background:rgba(255,122,89,.1)}
h1{margin:0 0 6px;font-size:23px;letter-spacing:-.02em}
.state{font-size:15px;color:var(--muted);min-height:22px}
.rows{margin-top:18px;border-top:1px solid var(--line);padding-top:14px;text-align:left;font-size:13px}
.rows div{display:flex;justify-content:space-between;gap:12px;padding:5px 0;color:var(--muted)}
.rows b{color:var(--text);font-weight:500;text-align:right}
.hint{margin-top:16px;font-size:12px;color:var(--muted);text-align:left;line-height:1.5}
a{color:var(--accent)}
.refresh{margin-top:14px;font-size:12px;color:var(--muted)}
</style></head><body><div class="wrap">
<div class="brand"><i>AV</i>${esc(BRAND)}</div>
<div class="card">${body}</div>
</div></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function probePage(env: Env, token: string, request: Request): Promise<Response> {
  const user = await one<UserRow>(env, "SELECT * FROM users WHERE sub_token = ?", token);
  if (!user) {
    return shell(
      "Ссылка не найдена",
      `<div class="dot off">✕</div><h1>Ссылка не найдена</h1>
       <div class="state">Проверьте, что скопировали её целиком</div>`,
    );
  }

  const snap = await snapshot(env, request);
  await recordPresence(env, user.id, snap, "probe");

  const who = user.tg_username ? `@${esc(user.tg_username)}` : `id ${esc(user.tg_id)}`;
  const name = snap.state === "on" ? "VPN включён" : "VPN выключен";
  const emoji = snap.state === "on" ? "🟢" : "⚪";
  const country = snap.node ? countryName(snap.node.country) : "";

  return shell(
    name,
    `<div class="dot ${snap.state}" id="dot">${emoji}</div>
     <h1 id="title">${esc(name)}</h1>
     <div class="state" id="sub">${snap.state === "on" ? "трафик идёт через наш узел" : "запрос пришёл напрямую, без туннеля"}</div>
     <div class="rows">
       <div><span>Кто</span><b>${who}</b></div>
       <div><span>Страна выхода</span><b id="country">${esc(country || "—")}</b></div>
       <div><span>Узел</span><b id="host">${esc(snap.node?.host ?? "—")}</b></div>
       <div><span>Проверено</span><b id="age">сейчас</b></div>
     </div>
     <div class="refresh" id="tick">слежу за статусом…</div>
     <div class="hint">Включите VPN и подождите пару секунд — индикатор обновится сам.
     Если VPN включён, а тут «выключен», значит клиент пускает этот запрос мимо туннеля
     (правило обхода или другой профиль).</div>
     <div class="hint"><a href="/keys/${esc(token)}">Все мои ключи</a> ·
     <a href="/sub/${esc(token)}">Подписка</a></div>
     <script>
const dot=document.getElementById("dot"),title=document.getElementById("title"),
      sub=document.getElementById("sub"),cEl=document.getElementById("country"),
      hEl=document.getElementById("host"),ageEl=document.getElementById("age"),
      tick=document.getElementById("tick");
function paint(d){
  const on=d.state==="on";
  dot.className="dot "+(on?"on":"off");
  dot.textContent=on?"🟢":"⚪";
  title.textContent=on?"VPN включён":"VPN выключен";
  sub.textContent=on?"трафик идёт через наш узел":"запрос пришёл напрямую, без туннеля";
  cEl.textContent=d.country||"—";
  hEl.textContent=d.host||"—";
  ageEl.textContent=d.age<5?"сейчас":d.ageText+" назад";
  tick.textContent="обновлено "+new Date().toLocaleTimeString("ru-RU");
}
async function poll(){
  try{
    const r=await fetch(location.pathname+"/state",{cache:"no-store"});
    if(r.ok) paint(await r.json());
  }catch(e){ tick.textContent="нет связи с сервером"; }
}
poll(); setInterval(poll,4000);
     </script>`,
  );
}

export async function probeState(env: Env, token: string, request: Request): Promise<Response> {
  const user = await one<{ id: number }>(env, "SELECT id FROM users WHERE sub_token = ?", token);
  if (!user) return Response.json({ error: "not found" }, { status: 404 });

  const snap = await snapshot(env, request);
  await recordPresence(env, user.id, snap, "probe");

  return Response.json(
    {
      state: snap.state,
      country: snap.node ? countryName(snap.node.country) : "",
      host: snap.node?.host ?? "",
      age: 0,
      ageText: humanAge(0),
      fresh: true,
      freshWindow: FRESH_SECONDS,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
