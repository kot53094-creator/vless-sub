/**
 * Автоотбор узлов для «белого списка».
 *
 * На мобильном интернете оператор режет всё, кроме разрешённых доменов:
 * обычный узел на нестандартном порту просто не открывается. Проходят
 * соединения, которые выглядят как обычный HTTPS к «разрешённому» адресу:
 *
 *   • порт 443 (реже 8443);
 *   • TLS или REALITY — трафик неотличим от браузерного;
 *   • в адресе домен, а не голый IP: оператор фильтрует по SNI/домену,
 *     и IP-адрес в этом режиме палится сразу.
 *
 * Такие узлы складываются в пул 3 — он же «Белые списки» — и в подписке
 * идут первыми: именно они работают там, где всё остальное не открывается.
 */

import { many, run } from "./db";
import type { Env } from "./types";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Домен, а не IP: есть буква и хотя бы одна точка. */
function isDomain(host: string): boolean {
  if (!host) return false;
  if (IPV4.test(host)) return false;
  return host.includes(".") && /[a-z]/i.test(host);
}

/**
 * Пометить подходящие узлы как «белый список».
 *
 * Фильтр по домену делается здесь, а не в SQL: GLOB с классами символов
 * в D1 ведёт себя непредсказуемо и роняет воркер, а проверка в JS
 * предсказуема и дешевле одного лишнего скана.
 */
export async function tagWhitelist(env: Env): Promise<number> {
  const rows = await many<{ id: number; host: string }>(
    env,
    `SELECT s.id, s.host
       FROM servers s
       JOIN sources src ON src.id = s.source_id
      WHERE s.enabled = 1
        AND s.status = 'alive'
        AND s.port IN (443, 8443)
        AND (s.link LIKE '%security=reality%' OR s.link LIKE '%security=tls%')
        AND (s.verified_latency_ms > 0 OR (s.exit_ip IS NOT NULL AND s.exit_ip <> ''))
        AND src.visibility = 'shareable'
      ORDER BY s.verified_latency_ms IS NULL, s.verified_latency_ms, s.id
      LIMIT 600`,
  );

  const ids = rows.filter((row) => isDomain(row.host)).slice(0, 300).map((row) => row.id);
  if (ids.length === 0) return 0;

  // Пачками по 50: одна вставка на 300 значений упирается в лимит запроса.
  let tagged = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const values = chunk.map((id) => `(3, ${Number(id)})`).join(", ");
    const result = await run(
      env,
      `INSERT OR IGNORE INTO pool_servers (pool_id, server_id) VALUES ${values}`,
    );
    tagged += result.meta?.changes ?? 0;
  }

  return tagged;
}

/** Сколько узлов сейчас в пуле «Белые списки». */
export async function countWhitelist(env: Env): Promise<number> {
  const rows = await many<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM pool_servers WHERE pool_id = 3",
  );
  return Number(rows[0]?.n ?? 0);
}
