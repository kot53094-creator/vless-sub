/**
 * Приём результатов настоящих проверок от внешнего агента.
 *
 * Агент запускается на GitHub Actions: поднимает Xray, подключается к узлу
 * и делает HTTPS-запрос через туннель. Cloudflare Worker так не умеет,
 * поэтому результаты приходят сюда по HTTP.
 *
 * Бюджет бесплатного плана: 50 запросов к D1 на вызов. Один результат —
 * это UPDATE + INSERT, поэтому принимаем не больше 20 результатов за раз
 * и пишем их одним batch. Агент отправляет пачками.
 *
 * Статус меняется по правилу «двух провалов»: одна неудача может быть
 * случайной (сеть раннера), две подряд — уже устойчивая недоступность.
 */

import { batch, logEvent, many, run, type SqlStatement } from "./db";
import { invalidateExitMap } from "./presence";
import { invalidatePool, loadPool, loadWhitelistPool } from "./sub";
import { checkTokenOk, envStr, timingSafeEqual } from "./security";
import type { Env } from "./types";

/** 20 результатов × 2 запроса = 40, плюс select и запись события. */
const MAX_RESULTS = 20;

interface CheckRow {
  id?: number;
  host?: string;
  ok?: boolean;
  latency?: number | null;
  error?: string | null;
  /** Выходной IP узла: агент узнаёт его запросом через туннель. */
  exit_ip?: string | null;
  /** Что открывается через узел: { tg: true, dc: false }. */
  blocked?: Record<string, boolean> | null;
  /** Флаги сервисов: tg/yt обязательные, dc/ig/gpt бонусные. */
  services?: Record<string, boolean> | null;
  /** Скорость скачивания через туннель, Мбит/с. */
  speed?: number | null;
  /**
   * Провал на транспорте, который наш агент не умеет проверять достоверно
   * (gRPC, XHTTP, HTTP/2 за CDN). Такой результат не должен приближать узел
   * к статусу «мёртв»: в клиенте он работает, а тест его просто не пробивает.
   */
  soft?: boolean;
}

/**
 * Очередь на проверку: сначала те, что давно не проверялись, и те, что уже
 * выданы людям. Агенту не нужно знать про базу — только этот список.
 */
export async function handleQueue(env: Env, request: Request): Promise<Response> {
  if (!(await checkTokenOk(env, request))) {
    return new Response("forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 40) || 40));
  const served = url.searchParams.get("served") === "1";
  const order = url.searchParams.get("order") ?? "";
  const single = Number(url.searchParams.get("id") ?? 0) || 0;

  // Очередь собирается из D1 и при частых прогонах агента (и ручных запусках
  // внахлёст) читает одни и те же строки. Короткий кэш в KV снимает
  // дублирующую нагрузку: два параллельных агента получают один список,
  // а не два полных сканирования. 90 секунд не мешают обходу — расписание
  // проверок заметно реже.
  const queueCacheKey = `queue:v1:${served ? "served" : "all"}:${limit}:${order}`;
  if (!single) {
    const cached = await env.CACHE.get(queueCacheKey).catch(() => null);
    if (cached) {
      return new Response(cached, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-queue-cache": "hit",
        },
      });
    }
  }
  const reply = async (queue: Array<{ id: number; link: string }>) => {
    const body = JSON.stringify({ queue });
    if (!single) {
      await env.CACHE.put(queueCacheKey, body, { expirationTtl: 90 }).catch(() => undefined);
    }
    return new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  };

  // ?served=1 — узлы, из которых прямо сейчас собирается подписка. Локальный
  // агент проверяет их первыми: мёртвый сервер должен исчезнуть из выдачи
  // через минуты, а не через сутки. Берём пул (он же кэш), а не тело
  // подписки: запрос тела регистрировал бы фальшивое устройство человека.
  //
  // В выдачу владельца попадают не только узлы основного пула: к ним
  // добавляются «белые списки» и запасные узлы с однажды подтверждённым
  // выходом. Их тоже надо перепроверять, иначе мёртвый запасной висит в
  // подписке до тех пор, пока до него не дойдёт общая очередь.
  if (served) {
    try {
      const [pool, whitelist, reserve] = await Promise.all([
        loadPool(env, true, false, true),
        loadWhitelistPool(env, false),
        many<{ id: number; link: string }>(
          env,
          `SELECT id, link FROM servers
            WHERE enabled = 1
              AND status = 'alive'
              AND verified_latency_ms IS NULL
              AND exit_ip IS NOT NULL AND exit_ip <> ''
              AND country_code IS NOT NULL AND country_code <> ''
            LIMIT 12`,
        ).catch(() => [] as Array<{ id: number; link: string }>),
      ]);
      const seen = new Set<number>();
      const merged = [...pool, ...whitelist.slice(0, 20), ...reserve].filter((row) =>
        seen.has(row.id) ? false : (seen.add(row.id), true),
      );
      // Порядок — от самых давно проверенных.
      //
      // Раньше очередь шла в порядке пула: первые 40 узлов проверялись
      // каждый прогон, а хвост старел неделями — отсюда «мёртвые» в списке
      // при живом агенте. Теперь каждый прогон берёт те, что дольше всех
      // ждали, и за несколько прогонов обходятся все.
      // order=pool — для ручного прогона: проверить ровно то, что сейчас
      // выдано людям, а не самые запущенные узлы базы.
      // Карантин тоже проверяем. Без этого новый источник никогда не
      // наберёт три подтверждённых узла: его серверы выключены (enabled = 0),
      // в пул не попадают и в очередь не зовутся — круг замкнутый.
      const quarantineSample = await many<{ id: number; link: string; verified_at: string | null }>(
        env,
        "SELECT s.id, s.link, s.verified_at FROM servers s JOIN sources src ON src.id = s.source_id " +
          "WHERE src.quarantine = 1 AND s.enabled = 0 AND s.status = 'alive' ORDER BY s.id DESC LIMIT 10",
      ).catch(() => [] as Array<{ id: number; link: string; verified_at: string | null }>);
      for (const row of quarantineSample) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row as never);
      }

      if (order !== "pool") {
        merged.sort((a, b) => {
          const left = String((a as { verified_at?: string | null }).verified_at ?? "");
          const right = String((b as { verified_at?: string | null }).verified_at ?? "");
          return left.localeCompare(right);
        });
      }
      const queue = merged.map((row) => ({ id: row.id, link: row.link }));
      return await reply(queue);
    } catch {
      return await reply([]);
    }
  }

  // Ручная проверка одного узла: ?id=269. Нужна, когда надо перепроверить
  // конкретный сервер, не дожидаясь общей очереди.
  if (single) {
    const one = await many<{ id: number; link: string }>(
      env,
      `SELECT id, link FROM servers
        WHERE id = ? AND enabled = 1`,
      single,
    );
    return Response.json({ queue: one });
  }

  // Мёртвые узлы тоже возвращаются в очередь, но редко и отдельной квотой:
  // сервер могли поднять, маршрут — восстановиться. Без этого статус 'dead'
  // был приговором навсегда, и пул только убывал. Квота не даёт им вытеснять
  // свежих кандидатов.
  const deadQuota = Math.max(2, Math.floor(limit / 5));
  const liveLimit = Math.max(1, limit - deadQuota);

  // Агент проверяет REALITY и WS+TLS; vmess/trojan и голый TLS не умеет.
  const checkable = `(
    lower(s.link) LIKE '%security=reality%'
    OR (lower(s.link) LIKE '%security=tls%' AND lower(s.link) LIKE '%type=ws%')
  )`;

  // Порядок — по времени последней проверки, а не по «важности». last_check_at
  // ставится на любой результат, поэтому очередь идёт по кругу и обходит весь
  // живой пул, а не топчется на десятке узлов.
  // Если D1 сейчас недоступна (исчерпана суточная квота, сбой), очередь
  // собирается из KV-пула: он тот же, что идёт в подписку. Проверка не
  // встаёт целиком из-за лимита базы.
  let live: Array<{ id: number; link: string }> = [];
  let dead: Array<{ id: number; link: string }> = [];
  try {
    live = await many<{ id: number; link: string }>(
      env,
      `SELECT s.id, s.link FROM servers s
        WHERE s.enabled = 1
          AND s.status <> 'dead'
          AND ${checkable}
        ORDER BY COALESCE(s.last_check_at, '1970-01-01') ASC, s.id
        LIMIT ?`,
      liveLimit,
    );

    dead = await many<{ id: number; link: string }>(
      env,
      `SELECT s.id, s.link FROM servers s
        WHERE s.enabled = 1
          AND s.status = 'dead'
          AND COALESCE(s.last_check_at, '1970-01-01') < datetime('now','-6 hours')
          AND ${checkable}
        ORDER BY COALESCE(s.last_check_at, '1970-01-01') ASC
        LIMIT ?`,
      deadQuota,
    );
  } catch {
    try {
      const [pool, whitelist] = await Promise.all([
        loadPool(env, false, false, false),
        loadWhitelistPool(env, false),
      ]);
      live = [...pool, ...whitelist]
        .slice(0, limit)
        .map((row) => ({ id: row.id, link: row.link }));
    } catch {
      live = [];
    }
  }

  return await reply([...live, ...dead]);
}

export async function handleChecks(env: Env, request: Request): Promise<Response> {
  if (!(await checkTokenOk(env, request))) {
    return new Response("forbidden", { status: 403 });
  }

  let payload: { results?: CheckRow[]; region?: string };
  try {
    payload = (await request.json()) as { results?: CheckRow[]; region?: string };
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const incoming = Array.isArray(payload.results) ? payload.results : [];
  const results = incoming
    .filter((row) => row && row.id && typeof row.ok === "boolean")
    .slice(0, MAX_RESULTS);
  if (!results.length) return Response.json({ updated: 0, rejected: incoming.length });
  const fromRu = (payload.region ?? "").trim().toLowerCase() === "ru";

  // Прошлые туннельные проверки для этих же серверов — одним запросом.
  // Нужны только две последние на сервер, чтобы понять серию провалов.
  const ids = results.map((row) => Number(row.id));
  const placeholders = ids.map(() => "?").join(",");
  const previous = await many<{ server_id: number; result: string; rn: number }>(
    env,
    `SELECT server_id, result, rn FROM (
       SELECT server_id, result,
              ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY id DESC) AS rn
         FROM server_checks
        WHERE kind = 'tunnel' AND server_id IN (${placeholders})
     ) WHERE rn <= 2`,
    ...ids,
  );

  const lastResult = new Map<number, string>();
  for (const row of previous) {
    if (row.rn === 1 && !lastResult.has(row.server_id)) {
      lastResult.set(row.server_id, row.result);
    }
  }

  const statements: SqlStatement[] = [];
  const dead: number[] = [];
  let updated = 0;
  let exitSeen = false;

  // Сеть агента живая, если в пачке кто-то прошёл туннель. Провал соседа
  // тогда означает, что дело в узле, а не в машине проверки.

  for (const row of results) {
    const id = Number(row.id);
    const latency = typeof row.latency === "number" ? Math.round(row.latency) : null;
    // ok → жив; провал после провала → мёртв; первый провал → «неизвестно»,
    // чтобы случайная ошибка раннера не выбивала рабочий узел из подписки.
    // Мягкий провал (gRPC/XHTTP/CDN) не считается смертью узла: тест его не
    // пробивает, а в клиенте он рабочий. Иначе автоматика выкашивает живые
    // узлы, и подписка «не меняется», потому что меняться уже нечему.
    // Из подписки узел уходит сразу после первого провала: пул требует
    // status='alive'. Но в 'dead' он попадает только со второго провала
    // подряд. Иначе один случайный сбой выкашивал рабочий сервер навсегда —
    // а с ним и половину и без того короткого списка.
    const status = row.ok
      ? "alive"
      : fromRu
        ? "dead"
        : row.soft
        ? "unknown"
        : lastResult.get(id) === "fail"
          ? "dead"
          : "unknown";

    // Выходной IP: только у живого узла и только если он похож на IP.
    // По нему потом определяется «включён ли VPN» у человека.
    const exitIp =
      row.ok && typeof row.exit_ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$|:/.test(row.exit_ip.trim())
        ? row.exit_ip.trim().slice(0, 45)
        : null;
    if (exitIp) exitSeen = true;

    // Одна осечка не повод выкидывать узел из подписки.
    //
    // Если проверка провалилась, но узел ещё не признан мёртвым (первый
    // провал), оставляем старые verified_* как есть: человек продолжает
    // видеть сервер, пока не станет ясно, что он действительно умер.
    // Затираем только когда статус дошёл до dead.
    const keepVerified = !row.ok && status !== "dead";

    if (fromRu) {
      statements.push({
        sql: row.ok
          ? "UPDATE servers SET ru_dead_at = NULL WHERE id = ?"
          : "UPDATE servers SET ru_dead_at = datetime('now') WHERE id = ?",
        params: [id],
      });
    }

    statements.push(
      {
        sql: keepVerified
          ? `UPDATE servers SET status = ?, last_check_at = datetime('now') WHERE id = ?`
          : `UPDATE servers SET status = ?,
                  verified_at = datetime('now'),
                  last_check_at = datetime('now'),
                  verified_latency_ms = ?,
                  exit_ip = COALESCE(?, exit_ip),
                  speed_mbps = COALESCE(?, speed_mbps)
            WHERE id = ?`,
        params: keepVerified
          ? [status, id]
          : [status, row.ok ? latency : null, exitIp, row.speed ?? null, id],
      },
      {
        sql: `INSERT INTO server_checks (server_id, result, latency_ms, error, kind)
         VALUES (?, ?, ?, ?, 'tunnel')`,
        params: [
          id,
          row.ok ? "ok" : "fail",
          latency,
          row.ok ? null : (row.error ?? "tunnel failed").slice(0, 160),
        ],
      },
    );
    // Открывает ли узел Telegram и Discord. Проверяется только у живого:
    // у мёртвого и так нечего мерить, а старую метку не затираем.
    // Флаги сервисов приходят в row.services (tg, yt — обязательные;
    // dc, ig, gpt — бонусные). Узел считается годным, только если открываются
    // оба обязательных: иначе он не обходит блокировки.
    if (row.ok && row.services && typeof row.services === "object") {
      const flags = Object.entries(row.services).map(([key, value]) => [key, value === true]);
      if (flags.length) {
        const passed = flags.filter(([, ok]) => ok).length;
        const summary = flags.map(([key, ok]) => `${key}:${ok ? "ok" : "fail"}`).join(",");
        statements.push({
          sql: `UPDATE servers SET blocked_ok = ?, blocked_probe = ?, blocked_at = datetime('now')
              WHERE id = ?`,
          // Годность определяют только обязательные сервисы. Необязательные
          // влияют на сортировку, но не выбрасывают узел из подписки.
          params: [
            (row.services as Record<string, boolean>).tg === true &&
              (row.services as Record<string, boolean>).yt === true
              ? 1
              : 0,
            summary.slice(0, 60),
            id,
          ],
        });
      }
    }

    if (status === "dead") dead.push(id);
    updated += 1;
  }

  await batch(env, statements);
  if (exitSeen) await invalidateExitMap(env);
  // Свежие проверки должны попадать в подписку сразу. Раньше снимок пула
  // жил своим часом по TTL, поэтому новый живой узел появлялся у людей
  // только через час, а умерший — висел так же долго.
  if (updated > 0) {
    try {
      await invalidatePool(env);
      // Штамп в ключе кэша подписки: тело пересобирается на следующем же
      // запросе, а не через 15 минут (до смены эпохи ротации).
      await env.CACHE.put("pool:stamp", String(Date.now()));
    } catch {
      /* снимок пересоберётся по TTL — приём результатов важнее */
    }
  }

  await run(
    env,
    "INSERT INTO events (type, user_id, details) VALUES (?, ?, ?)",
    "checks_api",
    null,
    `агент прислал результатов: ${updated}${dead.length ? `, мёртвых: ${dead.length}` : ""}`,
  );

  return Response.json({
    updated,
    rejected: incoming.length - results.length,
    dead: dead.length,
    // Агент по этому полю понимает, что пачку надо дослать.
    truncated: incoming.length > MAX_RESULTS,
  });
}
