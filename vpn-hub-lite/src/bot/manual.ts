/**
 * Ручные пометки узлов админом.
 *
 * Проверка туннелей идёт с раннера GitHub, то есть из США. Узел, живой для
 * раннера, у российского оператора может не открываться: другой маршрут,
 * другой DPI. Жалоба человека — самый точный детектор, поэтому админу нужна
 * команда «вот этот не работает», чтобы убрать узел сразу, не дожидаясь
 * следующего прогона и не надеясь на зарубежный замер.
 */

import { replaceDeadServer } from "../balance";
import { logEvent, many, run } from "../db";
import { invalidatePool } from "../sub";
import type { Env } from "../types";

interface Row {
  id: number;
  host: string;
  port: number;
  country_name: string | null;
}

/** Найти узел по host:port, по хосту или по названию страны. */
async function findServers(env: Env, query: string): Promise<Row[]> {
  const q = query.trim();
  const parts = q.split(":");
  const hostPart = parts[0] ?? q;
  const port = Number(parts[1]);

  if (Number.isFinite(port) && port > 0) {
    return many<Row>(
      env,
      "SELECT id, host, port, country_name FROM servers WHERE host = ? AND port = ? LIMIT 2",
      hostPart,
      port,
    );
  }

  return many<Row>(
    env,
    "SELECT id, host, port, country_name FROM servers WHERE host LIKE ? OR country_name LIKE ? ORDER BY (status = 'alive') DESC LIMIT 6",
    `%${q}%`,
    `%${q}%`,
  );
}

function resolveOne(rows: Row[], query: string): Row | string {
  if (rows.length === 0) return `Не нашёл узел по запросу «${query}».`;
  if (rows.length > 1) {
    const list = rows
      .slice(0, 5)
      .map((row) => `• ${row.host}:${row.port} — ${row.country_name ?? "?"}`)
      .join("\n");
    return `Под запрос попало несколько узлов. Уточните host:port:\n${list}`;
  }
  return rows[0];
}

export async function cmdMarkDead(env: Env, query: string): Promise<string> {
  const q = query.trim();
  if (!q) return "Формат: /dead host:port, /dead <страна> или /dead <имя>";

  const resolved = resolveOne(await findServers(env, q), q);
  if (typeof resolved === "string") return resolved;

  await run(
    env,
    "UPDATE servers SET status = 'dead', last_check_at = datetime('now') WHERE id = ?",
    resolved.id,
  );
  const replaced = await replaceDeadServer(env, resolved.id);
  await invalidatePool(env);
  await logEvent(env, "manual_dead", null, `${resolved.host}:${resolved.port}`);
  return `Убран: ${resolved.country_name ?? "?"} ${resolved.host}:${resolved.port} · перевешено людей: ${replaced.length}`;
}

/** Вернуть узел в пул, если убрали по ошибке. */
export async function cmdMarkAlive(env: Env, query: string): Promise<string> {
  const q = query.trim();
  if (!q) return "Формат: /alive host:port, /alive <страна> или /alive <имя>";

  const resolved = resolveOne(await findServers(env, q), q);
  if (typeof resolved === "string") return resolved;

  await run(
    env,
    "UPDATE servers SET status = 'alive', last_check_at = datetime('now') WHERE id = ?",
    resolved.id,
  );
  await invalidatePool(env);
  await logEvent(env, "manual_alive", null, `${resolved.host}:${resolved.port}`);
  return `Возвращён в пул: ${resolved.country_name ?? "?"} ${resolved.host}:${resolved.port}`;
}
