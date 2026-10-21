/**
 * Cron «health» — раз в 30 минут.
 *
 * Проверяем ограниченную партию серверов (по кругу), чтобы уложиться
 * в 10 мс CPU и 6 одновременных соединений. Мёртвые серверы заменяем
 * у всех, кому они выданы, и уведомляем людей.
 */

import { connect } from "cloudflare:sockets";

import { logEvent, many, run } from "./db";
import { replaceDeadServer } from "./balance";
import { notifyUser, sendToAdmin } from "./bot/telegram";
import { dailyDigest } from "./reports";
import type { Env, Health } from "./types";

// 24 вместо 8: после загрузки больших источников пул иначе проверяется сутками.
// 24 проверки + уведомления укладываются в лимит 50 подзапросов на вызов.
const BATCH = 30;
const TIMEOUT_MS = 1500;

interface CheckRow {
  id: number;
  host: string;
  port: number;
  status: Health;
  source_kind: string;
  source_name: string;
}

export interface HealthResult {
  checked: number;
  dead: number;
  replaced: number;
}

/** TCP-проверка порта через cloudflare:sockets. */
export async function tcpLatency(
  host: string,
  port: number,
  timeoutMs = TIMEOUT_MS,
): Promise<number | null> {
  const started = Date.now();
  let socket: ReturnType<typeof connect> | null = null;
  try {
    socket = connect({ hostname: host, port });
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return Date.now() - started;
  } catch {
    return null;
  } finally {
    try {
      socket?.close();
    } catch {
      /* сокет мог не открыться — это нормально */
    }
  }
}

export async function runHealth(env: Env): Promise<HealthResult> {
  const servers = await many<CheckRow>(
    env,
    `SELECT s.id, s.host, s.port, s.status, s.status AS server_status,
            src.kind AS source_kind, src.name AS source_name
     FROM servers s JOIN sources src ON src.id = s.source_id
     -- Сначала те, что уже выданы людям: их состояние важнее всего.
     ORDER BY EXISTS (SELECT 1 FROM assignments a WHERE a.server_id = s.id) DESC,
              (s.last_check_at IS NOT NULL), s.last_check_at
     LIMIT ?`,
    BATCH,
  );

  const result: HealthResult = { checked: 0, dead: 0, replaced: 0 };

  for (const server of servers) {
    // paid_private и trial проверяем только по порту — TLS не трогаем.
    const latency = await tcpLatency(server.host, server.port);
    // Порт может быть закрыт для Cloudflare, хотя для клиента сервер жив
    // (например, VLESS через Cloudflare). Поэтому «не ответил» ≠ «мёртвый».
    const status: Health =
      latency === null ? (server.status === "alive" ? "alive" : "unknown") : "alive";

    await run(
      env,
      "UPDATE servers SET status = ?, latency_ms = ?, last_check_at = datetime('now') WHERE id = ?",
      status,
      latency,
      server.id,
    );
    result.checked += 1;

    if ((status as string) === "dead") {
      result.dead += 1;
      if (server.status !== "dead") {
        await logEvent(env, "server_dead", null, `${server.host}:${server.port}`);
        const affected = await replaceDeadServer(env, server.id);
        result.replaced += affected.length;
        for (const userId of affected) {
          await notifyUser(
            env,
            userId,
            "Серверы обновлены — обновите подписку в Happ (потяните вниз на экране подписки).",
          );
        }
        if (affected.length > 0) {
          await sendToAdmin(
            env,
            `Сервер ${server.host}:${server.port} умер, заменён у ${affected.length} чел.`,
          );
        }
      }
    }
  }

  // Обновляем состояние источника по его серверам.
  await run(
    env,
    `UPDATE sources SET status = CASE
        WHEN EXISTS (SELECT 1 FROM servers s WHERE s.source_id = sources.id AND s.status='alive') THEN 'alive'
        WHEN EXISTS (SELECT 1 FROM servers s WHERE s.source_id = sources.id) THEN 'dead'
        ELSE sources.status END
     WHERE id IN (SELECT DISTINCT source_id FROM servers WHERE seen_at IS NOT NULL)`,
  );

  const hour = new Date().getUTCHours();
  if (hour === 3) {
    const flag = `daily:${new Date().toISOString().slice(0, 10)}`;
    if (!(await env.CACHE.get(flag))) {
      await env.CACHE.put(flag, "1", { expirationTtl: 36 * 3600 });
      await dailyDigest(env);
    }
  }

  return result;
}
