/**
 * Ручная проверка выбранных серверов из админки.
 *
 * Отдельный модуль, чтобы не раздувать health.ts: тот работает пакетами по
 * расписанию, а здесь нужно проверить конкретные id прямо сейчас.
 * Лимит 10 за вызов — каждый сервер это TCP-проба + два запроса к D1.
 */

import { many, run } from "./db";
import { tcpLatency } from "./health";
import type { Env } from "./types";

export interface ManualCheckResult {
  checked: number;
  alive: number;
}

export async function checkServerIds(env: Env, ids: number[]): Promise<ManualCheckResult> {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))].slice(0, 10);
  if (!unique.length) return { checked: 0, alive: 0 };

  const placeholders = unique.map(() => "?").join(",");
  const servers = await many<{ id: number; host: string; port: number }>(
    env,
    `SELECT id, host, port FROM servers WHERE id IN (${placeholders})`,
    ...unique,
  );

  let alive = 0;
  for (const server of servers) {
    const latency = await tcpLatency(server.host, server.port);
    await run(
      env,
      "UPDATE servers SET status = ?, latency_ms = ?, last_check_at = datetime('now') WHERE id = ?",
      latency === null ? "dead" : "alive",
      latency,
      server.id,
    );
    await run(
      env,
      "INSERT INTO server_checks (server_id, result, latency_ms, error) VALUES (?, ?, ?, ?)",
      server.id,
      latency === null ? "fail" : "ok",
      latency,
      latency === null ? "tcp: нет ответа" : null,
    );
    if (latency !== null) alive += 1;
  }

  return { checked: servers.length, alive };
}
