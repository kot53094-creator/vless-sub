/**
 * Персональная витрина ключей /keys/<token>.
 *
 * Показывает только то, что реально прошло проверку через туннель,
 * сгруппировано по странам, с кнопкой копирования каждой ссылки.
 *
 * Публичной версии намеренно нет: выложить рабочие ключи в открытый
 * доступ — значит сжечь их за сутки. Токен и есть пропуск.
 */

import { many, one } from "./db";
import { isModern } from "./ranking";
import type { Env, UserRow } from "./types";

interface KeyRow {
  id: number;
  link: string;
  remark: string;
  country_name: string | null;
  city: string | null;
  country_code: string | null;
  verified_latency_ms: number | null;
  verified_at: string | null;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function protoOf(link: string): string {
  if (/security=reality/i.test(link)) return "REALITY";
  if (/type=ws/i.test(link)) return "WS/TLS";
  return "VLESS";
}

function card(row: KeyRow): string {
  const country = row.country_name ?? "Другое";
  const city = row.city ? `, ${row.city}` : "";
  const latency = row.verified_latency_ms ?? 0;
  const speed = latency < 700 ? "fast" : latency < 1500 ? "mid" : "slow";
  return `<article class="key">
    <div class="key-head">
      <span class="country">${esc(country)}${esc(city)}</span>
      <span class="lat ${speed}">${latency} мс</span>
    </div>
    <div class="key-meta">
      <span class="badge">${protoOf(row.link)}</span>
      <span class="muted">${esc(row.remark.slice(0, 42) || "сервер")}</span>
    </div>
    <div class="key-actions">
      <button class="copy" data-link="${esc(row.link)}">Скопировать</button>
      <span class="muted small">проверен ${esc((row.verified_at ?? "").slice(0, 16))}</span>
    </div>
  </article>`;
}

export async function keysPage(env: Env, token: string): Promise<Response> {
  const clean = (token ?? "").trim();
  if (clean.length < 20) return new Response("Не найдено", { status: 404 });

  const user = await one<UserRow>(
    env,
    "SELECT * FROM users WHERE sub_token = ?",
    clean,
  );
  if (!user) return new Response("Не найдено", { status: 404 });

  const rows = await many<KeyRow>(
    env,
    `SELECT s.id, s.link, s.remark, s.country_name, s.city, s.country_code,
            s.verified_latency_ms, s.verified_at
       FROM assignments a
       JOIN servers s ON s.id = a.server_id
      WHERE a.user_id = ? AND s.enabled = 1 AND s.verified_latency_ms IS NOT NULL
      ORDER BY s.verified_latency_ms ASC
      LIMIT 200`,
    user.id,
  );

  const usable = rows.filter((row) => isModern(row));
  const groups = new Map<string, KeyRow[]>();
  for (const row of usable) {
    const key = row.country_name ?? "Другое";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const sections = Array.from(groups.entries())
    .map(
      ([country, list]) => `<section>
        <h2>${esc(country)} <span class="muted small">${list.length}</span></h2>
        ${list.map(card).join("")}
      </section>`,
    )
    .join("");

  const body =
    usable.length > 0
      ? sections
      : `<p class="empty">Проверенных ключей пока нет. Как только узел пройдёт проверку через туннель, он появится здесь.</p>`;

  const html = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Ключи — Orange Frankenstein</title>
<style>
  :root{--bg:#0e1116;--panel:#151a21;--line:#232b36;--text:#e8edf4;--muted:#8b97a8;--accent:#ff7a1a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  header{padding:28px 20px 10px;max-width:860px;margin:0 auto}
  h1{margin:0 0 6px;font-size:22px}
  h2{font-size:15px;margin:26px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
  main{max-width:860px;margin:0 auto;padding:0 20px 60px}
  .muted{color:var(--muted)}
  .small{font-size:12px}
  .key{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
  .key-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .country{font-weight:600}
  .lat{font-variant-numeric:tabular-nums;font-size:13px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
  .lat.fast{color:#48d17a;border-color:#1f5133}
  .lat.mid{color:#f0c040;border-color:#4d3f14}
  .lat.slow{color:#ff7a6b;border-color:#54241f}
  .key-meta{display:flex;gap:10px;align-items:center;margin:8px 0 12px;min-height:20px}
  .badge{font-size:11px;letter-spacing:.05em;padding:2px 7px;border-radius:6px;background:#20180f;color:var(--accent);border:1px solid #3a2714}
  .key-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .copy{background:var(--accent);color:#15100a;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
  .copy:active{transform:translateY(1px)}
  .copy.done{background:#2f8a4e;color:#eafff0}
  .empty{color:var(--muted)}
  footer{max-width:860px;margin:0 auto;padding:0 20px 40px;color:var(--muted);font-size:13px}
  a{color:var(--accent)}
</style></head>
<body>
<header>
  <h1>Ваши ключи</h1>
  <div class="muted">Только узлы, прошедшие настоящую проверку через туннель: ${usable.length} шт.</div>
</header>
<main>${body}</main>
<footer>
  Ссылка на подписку: <a href="/sub/${esc(clean)}">/sub</a> ·
  <a href="/status">состояние сервиса</a>
</footer>
<script>
document.addEventListener("click", async (event) => {
  const button = event.target.closest(".copy");
  if (!button) return;
  const link = button.dataset.link || "";
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const area = document.createElement("textarea");
    area.value = link;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const original = button.textContent;
  button.textContent = "Скопировано";
  button.classList.add("done");
  setTimeout(() => { button.textContent = original; button.classList.remove("done"); }, 1500);
});
</script>
</body></html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    },
  });
}
