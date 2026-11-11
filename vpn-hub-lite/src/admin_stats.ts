/**
 * Страница «Статистика» в админке.
 *
 * Раньше цифры были только в списках: сколько узлов, кто где. Здесь — то,
 * что видно лишь в динамике: распределение по странам, средняя скорость
 * проверенных узлов и доля успешных проверок за неделю. Графики рисуются
 * инлайновым SVG/CSS, без внешних библиотек: админка должна открываться
 * и на медленном канале, и без CDN.
 */

import { many, one } from "./db";
import { page } from "./admin";
import { flagOf } from "./labels";
import type { Env } from "./types";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Totals {
  servers: number;
  alive: number;
  verified: number;
  dead: number;
  users: number;
  active: number;
  sources: number;
  quarantine: number;
}

interface CountryRow {
  country_name: string;
  code: string | null;
  n: number;
  lat: number | null;
}

interface DayRow {
  d: string;
  n: number;
  ok: number;
}

export async function statsPage(env: Env): Promise<Response> {
  const totals = await one<Totals>(
    env,
    `SELECT (SELECT COUNT(*) FROM servers) AS servers,
            (SELECT COUNT(*) FROM servers WHERE status='alive' AND enabled=1) AS alive,
            (SELECT COUNT(*) FROM servers WHERE status='dead') AS dead,
            (SELECT COUNT(*) FROM servers
              WHERE enabled=1 AND status='alive' AND verified_latency_ms>0
                AND verified_at >= datetime('now','-72 hours')) AS verified,
            (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE status='active') AS active,
            (SELECT COUNT(*) FROM sources) AS sources,
            (SELECT COUNT(*) FROM sources WHERE quarantine=1) AS quarantine`,
  );

  const countries = await many<CountryRow>(
    env,
    `SELECT country_name, MAX(country_code) AS code, COUNT(*) AS n,
            ROUND(AVG(verified_latency_ms)) AS lat
       FROM servers
      WHERE enabled = 1 AND status = 'alive'
        AND country_name IS NOT NULL AND country_name <> ''
      GROUP BY country_name
      ORDER BY n DESC
      LIMIT 12`,
  );

  const days = await many<DayRow>(
    env,
    `SELECT date(checked_at) AS d, COUNT(*) AS n,
            SUM(CASE WHEN result = 'ok' THEN 1 ELSE 0 END) AS ok
       FROM server_checks
      WHERE checked_at >= datetime('now','-7 days')
      GROUP BY date(checked_at)
      ORDER BY d`,
  );

  const speed = await one<{ avg: number | null; max: number | null }>(
    env,
    `SELECT ROUND(AVG(speed_mbps), 1) AS avg, ROUND(MAX(speed_mbps), 1) AS max
       FROM servers
      WHERE speed_mbps IS NOT NULL AND enabled = 1
        AND verified_at >= datetime('now','-72 hours')`,
  );

  const maxCountry = Math.max(1, ...countries.map((c) => c.n));
  const maxDay = Math.max(1, ...days.map((d) => d.n));

  const countryRows = countries
    .map((c) => {
      const flag = flagOf(c.code ?? "");
      const width = Math.max(2, Math.round((c.n / maxCountry) * 100));
      return `<tr data-row="${esc(c.country_name)}">
        <td>${flag ? `${flag} ` : ""}${esc(c.country_name)}</td>
        <td style="width:55%"><div style="background:#1d2430;border-radius:6px;height:10px">
          <div style="width:${width}%;height:10px;border-radius:6px;background:linear-gradient(90deg,#ff8a3d,#ffb066)"></div>
        </div></td>
        <td class="mono">${c.n}</td>
        <td class="mono">${c.lat ? `${c.lat} мс` : "—"}</td>
      </tr>`;
    })
    .join("");

  const bars = days
    .map((d) => {
      const h = Math.max(3, Math.round((d.n / maxDay) * 90));
      const rate = d.n ? Math.round((d.ok / d.n) * 100) : 0;
      const color = rate >= 60 ? "#4FE3C1" : rate >= 30 ? "#ffb066" : "#ff6b6b";
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1">
        <div style="font-size:11px;color:#8e99ab">${d.n}</div>
        <div style="width:100%;display:flex;align-items:flex-end;height:90px">
          <div title="${d.d}: ${d.n} проверок, ${rate}% успешных"
               style="width:100%;height:${h}px;border-radius:6px 6px 0 0;background:${color};opacity:.85"></div>
        </div>
        <div style="font-size:11px;color:#8e99ab">${d.d.slice(5)}</div>
        <div style="font-size:11px;color:${color}">${rate}%</div>
      </div>`;
    })
    .join("");

  const body = `
<h1>Статистика</h1>
<div class="sub">Пул, география и качество проверок за 7 дней</div>

<div class="card">
  <div class="head"><h2>Сейчас</h2></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
    <div><div class="muted" style="font-size:12px">Живых узлов</div>
      <div style="font-size:26px;font-weight:700">${totals?.alive ?? 0}</div></div>
    <div><div class="muted" style="font-size:12px">Проверено туннелем (72 ч)</div>
      <div style="font-size:26px;font-weight:700;color:#4FE3C1">${totals?.verified ?? 0}</div></div>
    <div><div class="muted" style="font-size:12px">Помечено мёртвыми</div>
      <div style="font-size:26px;font-weight:700;color:#ff6b6b">${totals?.dead ?? 0}</div></div>
    <div><div class="muted" style="font-size:12px">Людей (активных)</div>
      <div style="font-size:26px;font-weight:700">${totals?.active ?? 0}</div></div>
    <div><div class="muted" style="font-size:12px">Источников (в карантине)</div>
      <div style="font-size:26px;font-weight:700">${totals?.sources ?? 0} <span class="muted" style="font-size:14px">(${totals?.quarantine ?? 0})</span></div></div>
    <div><div class="muted" style="font-size:12px">Средняя скорость</div>
      <div style="font-size:26px;font-weight:700">${speed?.avg ?? "—"} <span class="muted" style="font-size:14px">Мбит/с</span></div></div>
  </div>
</div>

<div class="card">
  <div class="head"><h2>Проверки за 7 дней</h2></div>
  <p class="muted" style="margin-top:0;font-size:13px">
    Высота столбца — число проверок за день, цвет и процент — доля успешных.
    Проверки делает агент на GitHub Actions.
  </p>
  ${
    days.length
      ? `<div style="display:flex;gap:10px;align-items:flex-end;padding:8px 4px 0">${bars}</div>`
      : `<p class="muted">Пока нет данных: проверки начнут приходить после первого прогона агента.</p>`
  }
</div>

<div class="card">
  <div class="head"><h2>География пула</h2>
    <span class="muted" style="font-size:12px">топ-12 стран по числу живых узлов</span></div>
  <table>
    <thead><tr><th>Страна</th><th>Доля</th><th>Узлов</th><th>Средний пинг</th></tr></thead>
    <tbody>${countryRows || `<tr><td colspan="4" class="muted">Нет данных</td></tr>`}</tbody>
  </table>
</div>
`;

  return page("Статистика", body, "stats", env);
}
