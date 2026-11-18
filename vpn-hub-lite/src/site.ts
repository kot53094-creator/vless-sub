/**
 * Публичный сайт сервиса.
 *
 * Задачи страницы: объяснить, что продаётся, показать цену и увести в бота.
 * Оплата здесь не начинается — она живёт в боте (звёзды) и на `/pay/<id>`
 * (карта, крипта), поэтому на сайте нет ни форм, ни сбора данных.
 *
 * Формулировки осознанно без «обходов блокировок»: с 1 сентября 2025 года
 * реклама средств обхода блокировок в России запрещена, штрафы для граждан —
 * от 50 до 80 тыс. ₽. Сайт говорит о доступе, устройствах и поддержке.
 */

import { envStr } from "./security";
import type { Env } from "./types";
import { loadPlans, type PlanRow } from "./plans";
import { enabledProviders } from "./pay";
import { formatRub, starsForPlan, discountPercent } from "./pay/money";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
:root{--bg:#090D16;--bg2:#0D1420;--card:rgba(17,24,39,.72);--line:#1E2836;--text:#E8ECF3;--muted:#8A94A6;
--orange:#FF7A00;--orange2:#FF9A3D;--lime:#70E000}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:10;backdrop-filter:blur(14px);background:rgba(9,13,22,.82);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.2px}
.orange-dot{width:12px;height:12px;border-radius:50%;background:linear-gradient(135deg,var(--orange),var(--orange2));
box-shadow:0 0 16px rgba(255,122,0,.7)}
.nav-links{display:flex;gap:22px;font-size:14px;color:var(--muted)}
.nav-links a{text-decoration:none}
.nav-links a:hover{color:var(--text)}
.btn{display:inline-block;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:700;font-size:15px;
background:linear-gradient(135deg,var(--orange2),var(--orange));color:#0B0F16;border:0;cursor:pointer}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.hero{position:relative;padding:78px 0 40px;overflow:hidden}
.hero:before{content:"";position:absolute;inset:-30% 10% auto 10%;height:520px;
background:radial-gradient(closest-side,rgba(255,122,0,.22),transparent 70%);pointer-events:none}
.hero h1{font-size:clamp(32px,5vw,54px);line-height:1.08;margin:0 0 18px;letter-spacing:-1px}
.hero h1 span{background:linear-gradient(120deg,var(--orange2),var(--orange));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{max-width:620px;color:#B6C0D0;font-size:18px;margin:0 0 26px}
.hero-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.note{font-size:13px;color:var(--muted);margin-top:14px}
.badges{display:flex;gap:10px;flex-wrap:wrap;margin-top:26px}
.badge{font-size:13px;color:#C7D0DE;border:1px solid var(--line);background:var(--card);padding:7px 12px;border-radius:999px}
section{padding:44px 0}
h2{font-size:clamp(24px,3.4vw,34px);margin:0 0 8px;letter-spacing:-.4px}
.sub{color:var(--muted);margin:0 0 26px}
.grid{display:grid;gap:16px}
.g3{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}
.card h3{margin:0 0 8px;font-size:17px}
.card p{margin:0;color:#A9B4C4;font-size:14.5px}
.icon{font-size:22px;margin-bottom:12px;display:block}
.plans{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.plan{position:relative;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px;display:flex;
flex-direction:column;gap:8px}
.plan.featured{border-color:rgba(255,122,0,.55);box-shadow:0 18px 46px rgba(255,122,0,.12)}
.plan .tag{position:absolute;top:-11px;left:18px;background:linear-gradient(135deg,var(--orange2),var(--orange));
color:#0B0F16;font-size:12px;font-weight:800;padding:3px 10px;border-radius:999px}
.plan .title{font-size:15px;color:#B9C3D2}
.price{font-size:34px;font-weight:800;letter-spacing:-1px}
.price small{font-size:14px;font-weight:600;color:var(--muted);letter-spacing:0}
.stars{font-size:13px;color:var(--lime)}
.plan ul{margin:8px 0 14px;padding-left:18px;color:#A9B4C4;font-size:14px}
.plan .btn{margin-top:auto;text-align:center}
.steps{counter-reset:step;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.step{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;position:relative}
.step:before{counter-increment:step;content:counter(step);position:absolute;top:16px;right:18px;font-size:13px;font-weight:800;
color:var(--orange);opacity:.7}
.step b{display:block;margin-bottom:6px}
.step span{color:#A9B4C4;font-size:14px}
.faq{display:grid;gap:10px}
details{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
summary{cursor:pointer;font-weight:600;list-style:none}
summary::-webkit-details-marker{display:none}
details p{color:#A9B4C4;font-size:14.5px;margin:10px 0 0}
.cta{background:linear-gradient(135deg,rgba(255,122,0,.16),rgba(255,122,0,.04));border:1px solid rgba(255,122,0,.35);
border-radius:22px;padding:34px;text-align:center}
.cta h2{margin-bottom:8px}
footer{border-top:1px solid var(--line);padding:30px 0;color:var(--muted);font-size:13px}
.foot{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap}
.foot a{color:#9AA5B6;text-decoration:none;margin-right:14px}
.foot a:hover{color:var(--text)}
@media (max-width:640px){.nav-links{display:none}.hero{padding-top:52px}}
`;

function planCard(plan: PlanRow, plans: PlanRow[], env: Env): string {
  const stars = enabledProviders(env).includes("stars") && plan.price_rub > 0
    ? starsForPlan(plan, env)
    : 0;
  const discount = discountPercent(plan, plans);
  const badge = plan.badge || (discount > 0 ? `−${discount}%` : "");
  const perMonth = plan.days >= 60 ? Math.round(plan.price_rub / (plan.days / 30)) : 0;
  return `<div class="plan${plan.featured ? " featured" : ""}">
  ${badge ? `<span class="tag">${esc(badge)}</span>` : ""}
  <div class="title">${esc(plan.title)}</div>
  <div class="price">${formatRub(plan.price_rub)}</div>
  ${perMonth ? `<div class="stars">≈ ${formatRub(perMonth)} в месяц</div>` : ""}
  ${stars ? `<div class="stars">или ${stars} ⭐ в Telegram</div>` : ""}
  <ul>
    <li>${plan.days} дней доступа</li>
    <li>${plan.device_limit ? `до ${plan.device_limit} устройств` : "без ограничения устройств"}</li>
    <li>${plan.note ? esc(plan.note) : "все серверы и группы"}</li>
  </ul>
  <a class="btn${plan.featured ? "" : " ghost"}" href="#start">Выбрать</a>
</div>`;
}

export async function landingPage(env: Env): Promise<Response> {
  const base = envStr(env.PUBLIC_BASE_URL).replace(/\/$/, "");
  const bot = envStr(env.BOT_USERNAME);
  const telegram = bot ? `https://t.me/${bot}` : base || "#start";

  let plans: PlanRow[] = [];
  try {
    plans = (await loadPlans(env)).filter((plan) => plan.price_rub > 0 && plan.days > 0);
  } catch {
    plans = [];
  }
  const monthly = plans.find((plan) => plan.days <= 31);
  const cheapest = plans.length
    ? Math.min(...plans.map((plan) => (plan.days ? plan.price_rub / (plan.days / 30) : plan.price_rub)))
    : 0;

  const heroPrice = monthly ? formatRub(monthly.price_rub) : cheapest ? formatRub(cheapest) : "";
  const plansHtml = plans.length
    ? plans.map((plan) => planCard(plan, plans, env)).join("")
    : `<div class="card"><h3>Тарифы настраиваются</h3><p>Цены появятся здесь после настройки. Откройте бота — там актуальные условия и пробный доступ.</p></div>`;

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Апельсинка VPN — персональная подписка для ваших устройств</title>
<meta name="description" content="Персональная VPN-подписка: одна ссылка на все устройства, приложения Happ и INCY, поддержка в Telegram. Оплата звёздами, картой или криптой.">
<style>${CSS}</style></head><body>

<header><div class="wrap nav">
  <div class="logo"><span class="orange-dot"></span> Апельсинка VPN</div>
  <nav class="nav-links">
    <a href="#features">Возможности</a>
    <a href="#pricing">Тарифы</a>
    <a href="#start">Как подключить</a>
    <a href="#faq">Вопросы</a>
  </nav>
  <a class="btn" href="${esc(telegram)}">Открыть в Telegram</a>
</div></header>

<div class="wrap">
  <section class="hero">
    <h1>Одна подписка.<br><span>Все ваши устройства.</span></h1>
    <p>Персональная ссылка для приложений Happ и INCY. Подключение за минуту, автовыбор быстрого сервера,
    до пяти устройств на одной подписке и поддержка в Telegram.</p>
    <div class="hero-actions">
      <a class="btn" href="${esc(telegram)}">Подключиться${heroPrice ? ` · от ${heroPrice}` : ""}</a>
      <a class="btn ghost" href="#pricing">Смотреть тарифы</a>
    </div>
    <div class="note">Оплата звёздами Telegram, банковской картой или криптовалютой. Автоматических списаний нет.</div>
    <div class="badges">
      <span class="badge">📱 iOS · Android · Windows · macOS</span>
      <span class="badge">⚡ Автовыбор сервера</span>
      <span class="badge">🔒 Шифрование REALITY</span>
      <span class="badge">🛠 Поддержка в Telegram</span>
    </div>
  </section>

  <section id="features">
    <h2>Что входит в подписку</h2>
    <p class="sub">Никаких скрытых лимитов и «тарифов на скорость»: одна подписка — полный набор функций.</p>
    <div class="grid g4">
      <div class="card"><span class="icon">🌍</span><h3>Серверы в Европе и России</h3>
        <p>Группы EUROPE, RUSSIA и BACKUP, плюс режим AUTO — приложение само выбирает узел с наименьшей задержкой.</p></div>
      <div class="card"><span class="icon">📲</span><h3>До 5 устройств</h3>
        <p>Одна ссылка на телефон, ноутбук и планшет. Лишние устройства отвязываются в кабинете в один тап.</p></div>
      <div class="card"><span class="icon">🔁</span><h3>Смена сервера без перенастройки</h3>
        <p>Ссылка-подписка остаётся прежней: список серверов обновляется сам, приложение подхватывает изменения.</p></div>
      <div class="card"><span class="icon">💬</span><h3>Живая поддержка</h3>
        <p>Вопрос по подключению или оплате — в боте, командой <code>/paysupport</code>. Отвечает человек, не бот.</p></div>
    </div>
  </section>

  <section id="pricing">
    <h2>Тарифы</h2>
    <p class="sub">Срок добавляется к текущему. Чем дольше период — тем ниже цена месяца.</p>
    <div class="plans">${plansHtml}</div>
    <p class="note">Цена указана за весь период. Пробный доступ выдаётся новым пользователям в боте.</p>
  </section>

  <section id="start">
    <h2>Подключение за три шага</h2>
    <p class="sub">Без регистрации по почте и без пароля: вход через Telegram.</p>
    <div class="steps">
      <div class="step"><b>Откройте бота</b><span>Нажмите «Открыть в Telegram» и отправьте <code>/start</code>. Бот выдаст пробный доступ.</span></div>
      <div class="step"><b>Скопируйте ссылку</b><span>В кабинете — кнопка «Скопировать ссылку подписки». Или откройте её сразу в Happ.</span></div>
      <div class="step"><b>Добавьте в приложение</b><span>В Happ или INCY выберите «Импорт из буфера» и подключитесь. Сервер AUTO выберется сам.</span></div>
    </div>
  </section>

  <section id="faq">
    <h2>Частые вопросы</h2>
    <p class="sub">Если ответа нет — напишите в поддержку, поможем с настройкой.</p>
    <div class="faq">
      <details><summary>Какие приложения поддерживаются?</summary>
        <p>Happ и INCY на iOS и Android, а также клиенты с поддержкой ссылок-подписок на Windows и macOS. Ссылка выдаётся в формате, который понимают эти приложения.</p></details>
      <details><summary>Это одна ссылка на все устройства?</summary>
        <p>Да. Одна ссылка-подписка, количество одновременных устройств ограничено тарифом. Старые устройства можно отвязать в кабинете.</p></details>
      <details><summary>Что будет, когда закончится срок?</summary>
        <p>Доступ приостановится, но аккаунт и настройки сохранятся. После продления ссылка та же — заново настраивать ничего не нужно.</p></details>
      <details><summary>Как оплатить?</summary>
        <p>В боте — звёздами Telegram. На странице оплаты — банковской картой или криптовалютой. Все способы разовые: подписка не продлевается автоматически.</p></details>
      <details><summary>Можно вернуть деньги?</summary>
        <p>Да, в течение 3 дней после оплаты, если доступ не был предоставлен или сервис не работал по нашей вине. Порядок — в разделе <a href="/legal/refund">«Оплата и возврат»</a>.</p></details>
      <details><summary>Вы храните историю посещений?</summary>
        <p>Нет. Хранятся только данные аккаунта, устройств и платежей. Подробно — в <a href="/legal/privacy">политике конфиденциальности</a>.</p></details>
    </div>
  </section>

  <section>
    <div class="cta">
      <h2>Начните с бесплатного доступа</h2>
      <p class="sub">Пробный период включается сразу после <code>/start</code> — без карты и без оплаты.</p>
      <a class="btn" href="${esc(telegram)}">Открыть бота</a>
    </div>
  </section>
</div>

<footer><div class="wrap foot">
  <div>© 2026 Апельсинка VPN${envStr(env.LEGAL_ENTITY) ? ` · ${esc(envStr(env.LEGAL_ENTITY))}` : ""}</div>
  <div>
    <a href="/legal/oferta">Оферта</a>
    <a href="/legal/refund">Оплата и возврат</a>
    <a href="/legal/privacy">Конфиденциальность</a>
    <a href="/status">Состояние сервиса</a>
  </div>
</div></footer>
</body></html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
