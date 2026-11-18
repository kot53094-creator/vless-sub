/**
 * Юридические страницы: оферта, оплата и возврат, конфиденциальность.
 *
 * Это не «галочка для вида»: платный сервис без опубликованной оферты и
 * правил возврата невозможно ни продавать картой, ни защищать в споре с
 * покупателем. Тексты написаны под реальную схему сервиса (доступ по
 * подписке, без обещаний конкретных сайтов), но реквизиты берутся из
 * окружения — их обязан заполнить владелец.
 *
 * Юридическую силу имеет только проверенный юристом документ. Здесь —
 * рабочий каркас, который закрывает очевидные дыры и не врёт покупателю.
 */

import { envStr } from "./security";
import type { Env } from "./types";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Requisites {
  entity: string;
  inn: string;
  email: string;
  tg: string;
  base: string;
  configured: boolean;
}

function requisites(env: Env): Requisites {
  const entity = envStr(env.LEGAL_ENTITY);
  const inn = envStr(env.LEGAL_INN);
  const email = envStr(env.LEGAL_EMAIL);
  const tg = envStr(env.LEGAL_TG).replace(/^@/, "");
  return {
    entity,
    inn,
    email,
    tg,
    base: envStr(env.PUBLIC_BASE_URL).replace(/\/$/, ""),
    configured: Boolean(entity && email),
  };
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Апельсинка VPN</title>
<style>
:root{--bg:#090D16;--card:#111827;--line:#1F2937;--text:#E8ECF3;--muted:#8A94A6;--orange:#FF7A00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:28px 18px 60px}
a{color:var(--orange)}
h1{font-size:26px;margin:0 0 6px}
h2{font-size:18px;margin:28px 0 8px}
p,li{color:#C9D1DE}
.muted{color:var(--muted);font-size:13px}
.nav{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0 26px;font-size:14px}
.card{background:rgba(17,24,39,.7);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:18px 0}
.warn{border-color:rgba(255,122,0,.4);background:rgba(255,122,0,.08);font-size:14px}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}
ul{padding-left:20px}
</style></head><body><div class="wrap">
<div class="nav"><a href="/">Главная</a><a href="/legal/oferta">Оферта</a><a href="/legal/refund">Оплата и возврат</a><a href="/legal/privacy">Конфиденциальность</a></div>
${body}
<hr><p class="muted">Апельсинка VPN · документы обновлены 12.11.2026</p>
</div></body></html>`;
}

function requisitesBlock(env: Env): string {
  const req = requisites(env);
  if (!req.configured) {
    return `<div class="card warn"><b>Реквизиты не заполнены.</b> Владельцу сервиса нужно задать
<code>LEGAL_ENTITY</code>, <code>LEGAL_INN</code>, <code>LEGAL_EMAIL</code> и <code>LEGAL_TG</code> —
без них документ не является офертой конкретного лица.</div>`;
  }
  return `<div class="card"><b>Исполнитель</b><br>${esc(req.entity)}<br>
${req.inn ? `ИНН ${esc(req.inn)}<br>` : ""}
Почта: <a href="mailto:${esc(req.email)}">${esc(req.email)}</a>
${req.tg ? ` · Telegram: @${esc(req.tg)}` : ""}</div>`;
}

/** Оферта: что покупает человек и на каких условиях. */
export function ofertaPage(env: Env): Response {
  const req = requisites(env);
  const body = `
<h1>Публичная оферта</h1>
<p class="muted">Договор возмездного оказания услуг доступа к сервису «Апельсинка VPN».</p>
${requisitesBlock(env)}

<h2>1. Предмет</h2>
<p>Исполнитель предоставляет доступ к сервису персональных подписок для настройки защищённого
соединения на устройствах пользователя, а пользователь оплачивает этот доступ. Доступ состоит из
ссылки-подписки, которую пользователь добавляет в поддерживаемое приложение.</p>

<h2>2. Акцепт</h2>
<p>Оплата счёта означает полное согласие с этой офертой. До оплаты пользователь может прочитать
документ по адресу <a href="${esc(req.base)}/legal/oferta">${esc(req.base)}/legal/oferta</a>.</p>

<h2>3. Тарифы и оплата</h2>
<ul>
<li>Действующие тарифы, срок и цена показываются в боте и на странице оплаты до списания денег.</li>
<li>Оплата проходит через платёжные сервисы (Telegram Stars, банковская карта, криптовалюта).
Исполнитель не получает и не хранит данные банковской карты.</li>
<li>Срок доступа добавляется к текущему сроку. При повторной оплате остаток не сгорает.</li>
<li>Цена фиксируется в момент создания счёта и не меняется до окончания его действия.</li>
</ul>

<h2>4. Что сервис не обещает</h2>
<div class="card warn">
<p>Сервис предоставляет доступ к инфраструктуре и не гарантирует работу конкретных сайтов,
приложений или сервисов третьих лиц, а также отсутствие ограничений со стороны оператора связи
или государства. Скорость зависит от провайдера, страны и устройства пользователя.</p>
<p>Сервис нельзя использовать для противоправных действий. При нарушении доступ может быть
прекращён без возврата денег.</p>
</div>

<h2>5. Ограничения доступа</h2>
<p>Количество одновременных устройств указано в тарифе. Передача ссылки-подписки третьим лицам
сверх тарифа считается нарушением; в этом случае исполнитель может ограничить число устройств.</p>

<h2>6. Возврат</h2>
<p>Условия возврата — в документе <a href="${esc(req.base)}/legal/refund">«Оплата и возврат»</a>.
Кратко: в течение 3 дней с момента оплаты, если доступ не был предоставлен или сервис не работает
по вине исполнителя.</p>

<h2>7. Ответственность</h2>
<p>Ответственность исполнителя ограничена суммой последнего платежа пользователя. Исполнитель не
отвечает за перерывы, вызванные работой операторов связи, хостинга и платёжных систем.</p>

<h2>8. Изменения</h2>
<p>Оферта может меняться. Новая редакция публикуется на этой странице и не распространяется на уже
оплаченные периоды.</p>

<h2>9. Контакты</h2>
<p>Поддержка: ${req.tg ? `@${esc(req.tg)} в Telegram` : "в Telegram-боте сервиса"}${req.email ? `, <a href="mailto:${esc(req.email)}">${esc(req.email)}</a>` : ""}.
Команда <code>/paysupport</code> в боте — для вопросов по оплате.</p>`;

  return new Response(shell("Публичная оферта", body), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Оплата и возврат: то, что реально спрашивают в поддержке. */
export function refundPage(env: Env): Response {
  const req = requisites(env);
  const bot = envStr(env.BOT_USERNAME);
  const body = `
<h1>Оплата и возврат</h1>
<p class="muted">Как проходят платежи и в каких случаях деньги возвращаются.</p>
${requisitesBlock(env)}

<h2>Способы оплаты</h2>
<ul>
<li><b>Telegram Stars</b> — внутри бота и мини-приложения. Звёзды списывает Telegram, доступ
включается сразу после подтверждения.</li>
<li><b>Банковская карта</b> — на странице оплаты в браузере.</li>
<li><b>Криптовалюта (USDT, TON)</b> — на странице оплаты, курс фиксируется платёжным сервисом.</li>
</ul>
<p>Доступ включается автоматически. Если через 10 минут после оплаты срок не изменился —
напишите <code>/paysupport</code> в боте, приложите номер заказа из <code>/orders</code>.</p>

<h2>Возврат</h2>
<ul>
<li><b>3 дня с момента оплаты</b> — если доступ не был предоставлен или сервис не работает по нашей
вине. Возвращается полная сумма.</li>
<li><b>Двойная оплата</b> — лишний платёж возвращается полностью в любой момент.</li>
<li><b>После 3 дней</b> — возврат возможен пропорционально неиспользованному сроку, если проблема
на нашей стороне и не устранена за 72 часа.</li>
<li><b>Не возвращается</b> — если доступ работал, а причина отказа связана с устройством,
оператором связи или действиями пользователя (нарушение правил, передача ссылки третьим лицам).</li>
</ul>

<h2>Как запросить возврат</h2>
<p>Напишите в поддержку ${req.tg ? `@${esc(req.tg)}` : "в боте"}${req.email ? ` или на <a href="mailto:${esc(req.email)}">${esc(req.email)}</a>` : ""}.
Укажите номер заказа. Срок рассмотрения — до 3 рабочих дней; деньги приходят тем же способом,
которым была оплата, в сроки платёжной системы (обычно 1–10 дней).</p>

<h2>Отмена подписки</h2>
<p>Автоматических списаний нет: подписка не продлевается сама. Чтобы прекратить доступ, просто не
продлевайте её. Отвязать устройство можно в кабинете${bot ? ` или в боте @${esc(bot)}` : ""}.</p>`;

  return new Response(shell("Оплата и возврат", body), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Конфиденциальность: ровно те данные, которые сервис действительно хранит. */
export function privacyPage(env: Env): Response {
  const body = `
<h1>Политика конфиденциальности</h1>
<p class="muted">Какие данные хранит сервис и зачем. Только то, что действительно используется.</p>
${requisitesBlock(env)}

<h2>1. Что хранится</h2>
<ul>
<li><b>Telegram ID и username</b> — чтобы узнать человека и выдать подписку.</li>
<li><b>Токен подписки</b> — случайная строка в ссылке; по ней клиент получает список серверов.</li>
<li><b>Данные об устройствах</b> — метка устройства, время последнего запроса, факт блокировки.
Нужны, чтобы работал лимит устройств и кнопка «отвязать».</li>
<li><b>Хеш IP и User-Agent</b> (SHA-256 с солью) — для подсчёта уникальных обращений. Сам IP-адрес
не сохраняется.</li>
<li><b>Платежи</b> — сумма, дата, способ оплаты и идентификатор платежа у провайдера. Данные карты
не проходят через сервис.</li>
</ul>

<h2>2. Чего нет</h2>
<p>Сервис не хранит историю посещённых сайтов, содержимое трафика, DNS-запросы и переписку.
Технически Worker видит только факт запроса за подпиской.</p>

<h2>3. Зачем</h2>
<p>Данные используются исключительно для работы сервиса: выдача подписки, лимит устройств,
продление после оплаты, поддержка и защита от злоупотреблений. Передача третьим лицам возможна
только платёжному сервису в объёме, нужном для платежа, или по требованию закона.</p>

<h2>4. Сколько хранится</h2>
<p>Пока действует аккаунт. Журналы обращений и события чистятся по расписанию; платёжные записи
хранятся в течение срока, требуемого для бухгалтерии и споров.</p>

<h2>5. Права пользователя</h2>
<p>Можно запросить удаление аккаунта и связанных данных — напишите в поддержку. Удаление
прекращает доступ к подписке; возврат в этом случае считается по правилам
<a href="/legal/refund">«Оплата и возврат»</a>.</p>

<h2>6. Контакты</h2>
<p>Вопросы по данным: ${req_placeholder(env)}</p>`;

  return new Response(shell("Конфиденциальность", body), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function req_placeholder(env: Env): string {
  const req = requisites(env);
  const parts: string[] = [];
  if (req.email) parts.push(`<a href="mailto:${esc(req.email)}">${esc(req.email)}</a>`);
  if (req.tg) parts.push(`@${esc(req.tg)} в Telegram`);
  return parts.length ? parts.join(", ") : "через поддержку в Telegram-боте";
}

export function legalIndex(env: Env): Response {
  const body = `
<h1>Документы</h1>
<p class="muted">Три документа, которые описывают сервис: что покупается, как вернуть деньги и какие
данные хранятся.</p>
${requisitesBlock(env)}
<div class="card"><a href="/legal/oferta"><b>Публичная оферта</b></a><p class="muted">Предмет, тарифы, ответственность.</p></div>
<div class="card"><a href="/legal/refund"><b>Оплата и возврат</b></a><p class="muted">Способы оплаты, сроки, порядок возврата.</p></div>
<div class="card"><a href="/legal/privacy"><b>Конфиденциальность</b></a><p class="muted">Какие данные хранятся и сколько.</p></div>`;
  return new Response(shell("Документы", body), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
