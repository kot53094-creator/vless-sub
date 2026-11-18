/**
 * Приём расхода трафика от агента узлов.
 *
 * Почему отдельный эндпоинт, а не «посчитать в воркере»: Cloudflare Worker
 * видит только запрос за подпиской — сам трафик идёт мимо него, через
 * Xray-туннель на чужом сервере. Единственный, кто знает объём, — узел
 * (Xray stats API / Remnawave). Агент раз в N минут присылает дельты сюда.
 *
 * Формат:
 *   POST /api/traffic
 *   x-check-token: <CHECK_TOKEN>
 *   {
 *     "node": "de-frankfurt-1",
 *     "seq": 1234,                     // монотонный счётчик агента
 *     "items": [{ "token": "sub_…", "mb": 12.5 }]
 *   }
 *
 * Идемпотентность. Агент может отправить пачку повторно (таймаут, ретрай).
 * Чтобы расход не удвоился, храним последний `seq` по узлу: пачка с тем же
 * или меньшим номером отбрасывается. Это проще и надёжнее, чем хранить
 * идентификаторы всех пачек.
 *
 * Бюджет D1: 50 подзапросов на вызов, поэтому не больше 40 записей за раз —
 * остальное агент присылает следующей пачкой.
 */

import { batch, one, run, type SqlStatement } from "./db";
import { checkTokenOk, envStr } from "./security";
import type { Env } from "./types";

const MAX_ITEMS = 40;

interface TrafficItem {
  token?: string;
  mb?: number;
}

interface TrafficPayload {
  node?: string;
  seq?: number;
  items?: TrafficItem[];
}

export async function handleTraffic(env: Env, request: Request): Promise<Response> {
  if (!(await checkTokenOk(env, request))) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let payload: TrafficPayload;
  try {
    payload = (await request.json()) as TrafficPayload;
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const node = String(payload.node ?? "").slice(0, 60);
  const seq = Number(payload.seq ?? 0);
  const items = Array.isArray(payload.items) ? payload.items.slice(0, MAX_ITEMS) : [];
  if (!items.length) {
    return Response.json({ ok: true, accepted: 0, skipped: "empty" });
  }

  // Защита от повторной доставки той же пачки.
  if (node && Number.isFinite(seq) && seq > 0) {
    const key = `traffic:seq:${node}`;
    try {
      const last = Number((await env.CACHE.get(key)) ?? 0);
      if (Number.isFinite(last) && seq <= last) {
        return Response.json({ ok: true, accepted: 0, skipped: "duplicate" });
      }
      await env.CACHE.put(key, String(seq), { expirationTtl: 86_400 });
    } catch {
      // без KV работаем без дедупликации: лучше небольшой перерасход,
      // чем потерянный учёт
    }
  }

  const statements: SqlStatement[] = [];
  let accepted = 0;
  for (const item of items) {
    const token = String(item.token ?? "").trim();
    const mb = Number(item.mb ?? 0);
    if (!token || !Number.isFinite(mb) || mb <= 0) continue;
    // Потолок на одну запись: 50 ГБ за пачку — это ошибка агента, а не
    // реальный расход, и такая цифра не должна обнулить человеку тариф.
    const safe = Math.min(Math.round(mb * 10) / 10, 50 * 1024);
    statements.push({
      sql: `UPDATE users
               SET traffic_used_mb = traffic_used_mb + ?,
                   traffic_reported_at = datetime('now')
             WHERE sub_token = ?`,
      params: [safe, token.slice(0, 64)],
    });
    accepted += 1;
  }

  if (!statements.length) {
    return Response.json({ ok: true, accepted: 0, skipped: "no_valid_items" });
  }

  try {
    await batch(env, statements);
  } catch {
    return Response.json({ ok: false, error: "db" }, { status: 500 });
  }

  return Response.json({ ok: true, accepted });
}

/**
 * Месячный сброс счётчика — часть обслуживания.
 *
 * Тариф с квотой подразумевает «в месяц», а не «за всё время». Сбрасываем
 * по 30-дневному окну от последней отметки, чтобы дата не уезжала.
 */
export async function resetTrafficCounters(env: Env): Promise<number> {
  const result = await run(
    env,
    `UPDATE users
        SET traffic_used_mb = 0, traffic_reset_at = datetime('now')
      WHERE traffic_used_mb > 0
        AND (traffic_reset_at IS NULL OR traffic_reset_at < datetime('now', '-30 days'))`,
  );
  return result.meta?.changes ?? 0;
}

/** Сколько людей уже за квотой — для админки и уведомлений. */
export async function overQuotaCount(env: Env): Promise<number> {
  const row = await one<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM users
      WHERE traffic_gb > 0 AND traffic_used_mb >= traffic_gb * 1024
        AND status = 'active'`,
  );
  return Number(row?.n ?? 0);
}
