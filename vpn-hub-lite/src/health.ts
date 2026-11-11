/**
 * Cron «health» — раз в 30 минут.
 *
 * Проверяем ограниченную партию серверов (по кругу), чтобы уложиться
 * в 10 мс CPU и 6 одновременных соединений. Мёртвые серверы заменяем
 * у всех, кому они выданы, и уведомляем людей.
 */

import { connect } from "cloudflare:sockets";

import { logEvent, many, one, run } from "./db";
import { replaceDeadServer, topUpVerified } from "./balance";
import { flagOf, replacementLine } from "./labels";
import { notifyUser, sendToAdmin } from "./bot/telegram";
import { dailyDigest } from "./reports";
import type { Env, Health } from "./types";

// 24 вместо 8: после загрузки больших источников пул иначе проверяется сутками.
// 24 проверки + уведомления укладываются в лимит 50 подзапросов на вызов.
// 18, а не 30: на каждый сервер теперь два запроса (UPDATE + история),
// а лимит D1 — 50 запросов на вызов.
const BATCH = 12;
const TIMEOUT_MS = 1500;

interface CheckRow {
  id: number;
  host: string;
  port: number;
  status: Health;
  source_kind: string;
  source_name: string;
  /** Последняя настоящая проверка через туннель (внешний агент). */
  verified_at: string | null;
  verified_latency_ms: number | null;
  /** Гео умершего узла — по нему строится отчёт о замене. */
  country_name: string | null;
  country_code: string | null;
}

/**
 * Узел, который недавно прошёл проверку туннелем, живой по определению.
 * TCP-проба из Cloudflare может не пройти по десятку причин (порт закрыт для
 * дата-центра, geo-entry режет чужие IP), и раньше из-за этого узел получал
 * статус 'unknown' и выпадал из подписки — при том что через туннель он
 * отвечал. Факт соединения важнее пробы порта.
 */
function tunnelVerifiedRecently(row: CheckRow, maxAgeMs = 12 * 60 * 60 * 1000): boolean {
  if (!row.verified_at) return false;
  if ((row.verified_latency_ms ?? 0) <= 0) return false;
  const ts = Date.parse(`${row.verified_at.replace(" ", "T")}Z`);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < maxAgeMs;
}

export interface HealthResult {
  checked: number;
  dead: number;
  /** Сколько людей перевешено с умерших узлов. */
  replaced: number;
  /** Сколько узлов добрано, чтобы у людей снова было 15 подтверждённых. */
  topped: number;
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
  // Курсор в KV вместо сортировки по всей таблице. Прежний ORDER BY
  // с подзапросом EXISTS заставлял SQLite перечитывать все включённые узлы
  // на каждом тике — именно это и съедало суточную квоту D1 (5 млн строк),
  // после чего бот и подписки оставались без базы. Теперь читаем ровно BATCH
  // строк по первичному ключу и идём по кругу.
  const cachedCursor = await env.CACHE.get("health:cursor").catch(() => null);
  const cursor = Number(cachedCursor ?? "0") || 0;
  const columns = `s.id, s.host, s.port, s.status, s.status AS server_status,
            s.verified_at, s.verified_latency_ms,
            s.country_name, s.country_code,
            src.kind AS source_kind, src.name AS source_name`;
  let servers = await many<CheckRow>(
    env,
    `SELECT ${columns}
     FROM servers s JOIN sources src ON src.id = s.source_id
     WHERE s.enabled = 1 AND s.id > ?
     ORDER BY s.id
     LIMIT ?`,
    cursor,
    BATCH,
  );
  if (servers.length < BATCH) {
    const head = await many<CheckRow>(
      env,
      `SELECT ${columns}
       FROM servers s JOIN sources src ON src.id = s.source_id
       WHERE s.enabled = 1 AND s.id <= ?
       ORDER BY s.id
       LIMIT ?`,
      cursor,
      BATCH - servers.length,
    );
    servers = servers.concat(head);
  }
  if (servers.length) {
    await env.CACHE.put("health:cursor", String(servers[servers.length - 1].id), {
      expirationTtl: 30 * 86400,
    }).catch(() => {
      // без курсора просто начнём сначала — не повод падать
    });
  }

  const result: HealthResult = { checked: 0, dead: 0, replaced: 0, topped: 0 };
  /** Умерший узел → id узлов, которыми его заменили (у каждого человека свой). */
  const replacements: Array<{ dead: CheckRow; replaced: number[] }> = [];

  for (const server of servers) {
    // paid_private и trial проверяем только по порту — TLS не трогаем.
    const latency = await tcpLatency(server.host, server.port);
    // Порт может быть закрыт для Cloudflare, хотя для клиента сервер жив
    // (например, VLESS через Cloudflare). Поэтому «не ответил» ≠ «мёртвый».
    const proven = tunnelVerifiedRecently(server);
    const status: Health =
      latency === null ? (server.status === "alive" || proven ? "alive" : "unknown") : "alive";

    await run(
      env,
      // Замер не затираем нулём: неудачная проба порта не отменяет удачный
      // замер через туннель.
      `UPDATE servers SET status = ?, latency_ms = COALESCE(?, latency_ms),
              last_check_at = datetime('now') WHERE id = ?`,
      status,
      latency,
      server.id,
    );
    // История: по ней считается стабильность и видно, когда сервер просел.
    // kind='tcp': это только проверка порта. Настоящий тест туннеля делает
    // внешний агент и пишет kind='tunnel' — путать их нельзя.
    await run(
      env,
      `INSERT INTO server_checks (server_id, result, latency_ms, error, kind)
       VALUES (?, ?, ?, ?, 'tcp')`,
      server.id,
      latency === null ? "fail" : "ok",
      latency,
      latency === null ? "tcp: нет ответа" : null,
    );
    result.checked += 1;

    if ((status as string) === "dead") {
      if (server.status !== "dead") {
        // Считаем только новые падения: уже мёртвый узел при повторной
        // проверке не должен каждые 20 минут попадать в сводку.
        result.dead += 1;
        await logEvent(env, "server_dead", null, `${server.host}:${server.port}`);
        const affected = await replaceDeadServer(env, server.id);
        result.replaced += affected.length;
        for (const item of affected) {
          await notifyUser(
            env,
            item.user_id,
            "Серверы обновлены — обновите подписку в Happ (потяните вниз на экране подписки).",
          );
        }
        // Сообщение админу отправляем не на каждый узел, а одной сводкой
        // после тика: за 20 минут умирает по 5–10 узлов, и отдельные
        // сообщения превращаются в спам, в котором не видно главного.
        replacements.push({
          dead: server,
          replaced: affected.map((item) => item.server_id),
        });
      }
    }
  }

  // Обновляем состояние источника по его серверам.
  //
  // Запрос коррелированный: на каждый источник SQLite перебирает его серверы.
  // При 5 тысячах узлов и запуске каждые 20 минут это выжигало суточную квоту
  // D1, и бот начинал отвечать «база перегружена». Раз в 6 часов достаточно:
  // статус источника — витрина, а не данные для замены.
  const statusKey = "health:source-status-at";
  const statusAt = Number((await env.CACHE.get(statusKey)) ?? 0);
  if (Date.now() - statusAt >= 6 * 60 * 60 * 1000) {
    await run(
      env,
      `UPDATE sources SET status = CASE
        WHEN EXISTS (SELECT 1 FROM servers s WHERE s.source_id = sources.id AND s.status='alive') THEN 'alive'
        WHEN EXISTS (SELECT 1 FROM servers s WHERE s.source_id = sources.id) THEN 'dead'
        ELSE sources.status END
     WHERE id IN (SELECT DISTINCT source_id FROM servers WHERE seen_at IS NOT NULL)`,
    );
    await env.CACHE.put(statusKey, String(Date.now()), { expirationTtl: 7 * 24 * 3600 });
  }

  // Автоподмена, которая не ждёт статуса «dead».
  //
  // replaceDeadServer срабатывает только когда TCP-порт закрылся. Но узел может
  // быть живым по порту и при этом не проходить туннель (или его проверка
  // устарела) — тогда у человека пустеет список, хотя формально серверы есть.
  // Здесь добираем именно подтверждённые узлы до 12 штук.
  // Порядок — по нехватке подтверждённых узлов, а не по id.
  //
  // Раньше здесь стояло `ORDER BY id LIMIT 5`: каждые 20 минут добирались
  // одни и те же первые пять человек, а остальным узлы не добавлялись
  // никогда. Теперь первыми идут те, у кого подтверждённых меньше всего,
  // поэтому за несколько тиков добор проходит по всем.
  const activeUsers = await many<{ id: number }>(
    env,
    `SELECT u.id,
            (SELECT COUNT(*) FROM assignments a
               JOIN servers s ON s.id = a.server_id
              WHERE a.user_id = u.id
                AND s.status = 'alive'
                AND s.verified_latency_ms > 0
                AND s.verified_at >= datetime('now','-72 hours')) AS verified
       FROM users u
      WHERE u.status = 'active'
      ORDER BY verified ASC, u.id
      LIMIT 5`,
  );
  for (const user of activeUsers) {
    try {
      const added = await topUpVerified(env, user.id, 15);
      if (added > 0) result.topped += added;
    } catch {
      // Один упавший пользователь не должен ронять весь крон.
    }
  }

  // Одна сводка на тик вместо сообщения про каждый узел. В строках — страна
  // умершего и страна замены: «Германия → Финляндия» понятнее двух IP.
  if (result.dead > 0 || result.topped > 0) {
    const ids = [...new Set(replacements.flatMap((item) => item.replaced))];
    const rows = ids.length
      ? await many<{
          id: number;
          host: string;
          port: number;
          country_name: string | null;
          country_code: string | null;
        }>(
          env,
          `SELECT id, host, port, country_name, country_code
             FROM servers WHERE id IN (${ids.map(() => "?").join(",")})`,
          ...ids,
        )
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const place = (row: {
      host: string;
      port: number;
      country_name: string | null;
      country_code: string | null;
    }): string => {
      const flag = row.country_code ? flagOf(row.country_code) : "";
      const name = row.country_name || `${row.host}:${row.port}`;
      return flag ? `${flag} ${name}` : name;
    };

    const swapped = replacements.filter((item) => item.replaced.length > 0).length;
    const lines = [
      "🔁 Замена узлов",
      `проверено: ${result.checked} · упало: ${result.dead} · заменено: ${swapped} узлов · люди: ${result.replaced}`,
    ];
    for (const item of replacements.slice(0, 6)) {
      const targets = [...new Set(item.replaced)]
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .map(place);
      lines.push(replacementLine(place(item.dead), targets, item.replaced.length));
    }
    if (replacements.length > 6) lines.push(`и ещё ${replacements.length - 6} узлов`);
    if (result.topped > 0) lines.push(`добрано узлов: ${result.topped}`);
    await sendToAdmin(env, lines.join("\n"));
  }

  // Сторож пула: одна агрегатная выборка на тик. Он ловит не «мёртвый
  // сервер», а вымывание пула целиком — когда источники выдохлись и
  // проверенных узлов осталось меньше, чем нужно подписке.
  try {
    await watchPool(env);
  } catch {
    // Сторож не должен ронять саму проверку здоровья.
  }

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

/**
 * Сторож пула.
 *
 * «Никогда не умирает» держится не на одном удачном запуске, а на том, что
 * просадка видна сразу. Раз в тик считаем узлы, реально прошедшие проверку
 * трафиком за последние 72 часа, и кладём цифру в KV: её читают /status,
 * админка и отчёты. Если цифра ниже порога — один раз в час пишем админу.
 * Без этого о вымывании пула узнаёшь от людей: «VPN не работает».
 */
export async function watchPool(env: Env): Promise<{ verified: number; alert: boolean }> {
  const row = await one<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n
       FROM servers s JOIN sources src ON src.id = s.source_id
      WHERE s.enabled = 1
        AND s.status = 'alive'
        AND s.verified_latency_ms > 0
        -- То же окно, что и у подписки: сторож должен видеть ровно тот
        -- пул, из которого люди получают серверы.
        AND s.verified_at >= datetime('now','-72 hours')
        AND src.visibility = 'shareable'`,
  );
  const verified = Number(row?.n ?? 0);
  const threshold = Number(env.POOL_MIN ?? "") || 40;

  await env.CACHE.put(
    "pool:health",
    JSON.stringify({ verified, threshold, ts: Date.now() }),
    { expirationTtl: 86400 },
  );

  if (verified >= threshold) return { verified, alert: false };

  // Одно сообщение в час: иначе при долгой просадке бот завалит админа.
  const already = await env.CACHE.get("pool:alert");
  if (already) return { verified, alert: false };
  await env.CACHE.put("pool:alert", "1", { expirationTtl: 3600 });

  await sendToAdmin(
    env,
    `Пул просел: ${verified} проверенных узлов (порог ${threshold}). ` +
      "Подписка пока держится на резервном снимке; если через час не восстановится — смотрите /status.",
  );
  return { verified, alert: true };
}
