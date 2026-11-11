/**
 * Публичная страница сервиса.
 *
 * Задача страницы — чтобы открытая в браузере ссылка из карточки подписки
 * выглядела как продукт, а не как техническая заглушка: тариф, состояние
 * сервиса, кнопка поддержки. Никаких выдуманных цифр: объём тарифа берётся
 * из того же окружения, что и заголовок `subscription-userinfo`.
 */

import { BRAND_PREMIUM, BRAND_TAGLINE } from "./brand";
import { planDefaults } from "./premium";
import type { Env } from "./types";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function premiumLanding(env: Env): Response {
  const plan = planDefaults(env);
  const bot = (env.BOT_USERNAME ?? "").trim().replace(/^@/, "");
  const botUrl = bot ? `https://t.me/${encodeURIComponent(bot)}` : "";
  const base = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const traffic = `${plan.trafficGb} ГБ`;

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(BRAND_PREMIUM)}</title>
<style>
:root{--bg:#0b0d11;--panel:#141821;--line:#232936;--text:#eef1f6;--muted:#8e99ab;--orange:#ff8a3d;--orange2:#ff5f1f}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:
 radial-gradient(900px 500px at 15% -10%,rgba(255,138,61,.18),transparent 60%),
 radial-gradient(700px 400px at 90% 0%,rgba(90,120,255,.12),transparent 60%),
 var(--bg);color:var(--text);
 font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:940px;margin:0 auto;padding:44px 20px 64px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.3px}
.logo i{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;
 background:linear-gradient(140deg,var(--orange),var(--orange2));color:#1a1207;font-style:normal;font-weight:800}
.live{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);
 border:1px solid var(--line);background:#101420;border-radius:999px;padding:6px 12px}
.live b{width:8px;height:8px;border-radius:50%;background:#39d98a;box-shadow:0 0 0 4px rgba(57,217,138,.15)}
h1{font-size:40px;line-height:1.1;margin:34px 0 10px;letter-spacing:-.5px}
h1 span{background:linear-gradient(100deg,var(--orange),#ffd08a);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{color:var(--muted);max-width:560px;margin:0 0 26px;font-size:17px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:26px 0}
.card{background:linear-gradient(180deg,#151a24,#12161f);border:1px solid var(--line);
 border-radius:16px;padding:18px}
.card b{display:block;font-size:15px;margin-bottom:6px}
.card p{margin:0;color:var(--muted);font-size:14px}
.plan{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:center;margin-top:26px;
 background:linear-gradient(180deg,#191f2b,#12161f);border:1px solid #2c3444;border-radius:20px;padding:24px}
.plan h2{margin:0 0 4px;font-size:22px}
.plan .price{color:var(--muted);font-size:14px;margin:0 0 14px}
ul{margin:0;padding:0;list-style:none;display:grid;gap:9px;font-size:14px}
li{display:flex;gap:9px;color:#cfd7e5}
li:before{content:"✓";color:var(--orange);font-weight:700}
.cta{display:flex;flex-direction:column;gap:10px}
.btn{display:block;text-align:center;text-decoration:none;font-weight:650;padding:14px 18px;border-radius:12px;
 background:linear-gradient(140deg,var(--orange),var(--orange2));color:#180f04}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text);font-weight:500}
.muted{color:var(--muted);font-size:13px}
footer{margin-top:34px;display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;
 color:var(--muted);font-size:13px}
a{color:var(--orange);text-decoration:none}a:hover{text-decoration:underline}
@media(max-width:760px){h1{font-size:31px}.plan{grid-template-columns:1fr;padding:20px}}
</style></head><body><div class="wrap">

<div class="top">
  <div class="logo"><i>AV</i>${esc(BRAND_PREMIUM)}</div>
  <div class="live"><b></b>${esc(BRAND_TAGLINE)}</div>
</div>

<h1>Интернет <span>без обрывов</span></h1>
<p class="lead">Персональный доступ на протоколе VLESS REALITY. Серверы проверяются
каждые 20 минут: мёртвые выпадают из подписки и заменяются сами, без вашего участия.</p>

<div class="grid">
  <div class="card"><b>Всегда на связи</b><p>Проверка узлов каждые 20 минут и автозамена
    тех, что перестали пускать трафик.</p></div>
  <div class="card"><b>Неотличим от HTTPS</b><p>VLESS + REALITY: трафик выглядит как
    обычное защищённое соединение с сайтом.</p></div>
  <div class="card"><b>Автообновление</b><p>Подписка в приложении обновляется каждый час —
    вручную ничего делать не нужно.</p></div>
</div>

<div class="plan">
  <div>
    <h2>Premium</h2>
    <p class="price">${esc(traffic)} · персональная ссылка</p>
    <ul>
      <li>Только проверенные узлы — с реальным замером задержки</li>
      <li>Резервный список: если сервер упал, в списке остаются рабочие</li>
      <li>Страницы состояния и поддержки в один клик</li>
    </ul>
  </div>
  <div class="cta">
    ${botUrl ? `<a class="btn" href="${esc(botUrl)}">Получить доступ</a>` : ""}
    ${base ? `<a class="btn ghost" href="${esc(base)}/status">Состояние сервиса</a>` : ""}
    <p class="muted">Доступ выдаётся в Telegram после одобрения заявки.</p>
  </div>
</div>

<footer>
  <div>${esc(BRAND_PREMIUM)} · ${base ? esc(base.replace(/^https?:\/\//, "")) : "персональный хаб"}</div>
  <div>${base ? `<a href="${esc(base)}/status">Состояние</a> · <a href="${esc(base)}/api/v1/status">API</a>` : ""}</div>
</footer>

</div></body></html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
