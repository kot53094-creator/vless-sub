/**
 * Приём конфигураций: разбор, дедупликация и причины отклонения.
 *
 * Зачем отдельный модуль: раньше sync молча писал всё, что разобралось,
 * и в админке было видно только «серверов: 0». Теперь на каждый прогон
 * сохраняется разбор по причинам — можно отличить «источник отдал HTML»
 * от «источник отдал VLESS без pbk».
 *
 * Правила:
 *  • в базу попадает всё разобранное (историю не теряем);
 *  • в публичную REALITY-выдачу — только VLESS + REALITY с полным набором
 *    параметров, это и считает publishable;
 *  • секреты (UUID, pbk, ссылки) в статистику не пишем, только коды причин.
 */

import { decodePayload, parseUri, type ParsedKey } from "./parser";
import { checkReality } from "./reality";
import { many, run } from "./db";
import type { Env } from "./types";

export type RejectCode =
  | "unparsable"
  | "not_vless"
  | "security_not_reality"
  | "no_uuid"
  | "no_host"
  | "bad_port"
  | "no_pbk"
  | "no_sni"
  | "no_sid"
  | "no_fp"
  | "duplicate"
  | "limit";

export const REJECT_LABELS: Record<RejectCode, string> = {
  unparsable: "не разобралась ссылка",
  not_vless: "не VLESS",
  security_not_reality: "security не reality",
  no_uuid: "нет UUID",
  no_host: "нет адреса",
  bad_port: "некорректный порт",
  no_pbk: "нет pbk",
  no_sni: "нет sni",
  no_sid: "нет sid",
  no_fp: "нет fp",
  duplicate: "дубликат",
  limit: "сверх лимита прогона",
};

/** Тексты ошибок из reality.ts → машинные коды. */
const ERROR_TO_CODE: Record<string, RejectCode> = {
  "не VLESS": "not_vless",
  "security не reality": "security_not_reality",
  "нет UUID": "no_uuid",
  "нет адреса": "no_host",
  "нет порта": "bad_port",
  "нет pbk": "no_pbk",
  "нет sni": "no_sni",
  "нет sid": "no_sid",
  "нет fp": "no_fp",
  "не разбирается как URL": "unparsable",
};

export interface IntakeStats {
  lines: number;
  parsed: number;
  accepted: number;
  publishable: number;
  rejects: Record<string, number>;
}

export interface IntakeResult {
  keys: ParsedKey[];
  stats: IntakeStats;
}

/** Первая причина, по которой конфигурация не годится в REALITY-выдачу. */
export function classifyReality(uri: string): RejectCode | null {
  const check = checkReality(uri);
  if (check.ok) return null;
  for (const error of check.errors) {
    const code = ERROR_TO_CODE[error];
    if (code) return code;
  }
  return "unparsable";
}

function bump(rejects: Record<string, number>, code: RejectCode): void {
  rejects[code] = (rejects[code] ?? 0) + 1;
}

/**
 * Один проход по телу подписки: разбор, дедупликация по протоколу/хосту/порту
 * и подсчёт причин. Ключи возвращаются в том же виде, что и у
 * parseSubscription, поэтому вызывающий код не меняется.
 */
export function scanSubscription(text: string, limit = 200): IntakeResult {
  const stats: IntakeStats = {
    lines: 0,
    parsed: 0,
    accepted: 0,
    publishable: 0,
    rejects: {},
  };
  const keys: ParsedKey[] = [];
  const seen = new Set<string>();

  for (const uri of decodePayload(text ?? "")) {
    stats.lines += 1;
    if (keys.length >= limit) {
      bump(stats.rejects, "limit");
      continue;
    }

    const parsed = parseUri(uri);
    if (!parsed) {
      bump(stats.rejects, "unparsable");
      continue;
    }
    stats.parsed += 1;

    const fingerprint = `${parsed.proto}|${parsed.host.toLowerCase()}|${parsed.port}`;
    if (seen.has(fingerprint)) {
      bump(stats.rejects, "duplicate");
      continue;
    }
    seen.add(fingerprint);

    keys.push(parsed);
    stats.accepted += 1;

    const reject = classifyReality(parsed.uri);
    if (reject) bump(stats.rejects, reject);
    else stats.publishable += 1;
  }

  return { keys, stats };
}

/** Компактная строка для админки: «не VLESS 12 · нет pbk 3». */
export function describeRejects(rejects: Record<string, number>): string {
  return Object.entries(rejects)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${REJECT_LABELS[code as RejectCode] ?? code} ${count}`)
    .join(" · ");
}

/** Хранить историю дольше смысла нет: интересна последняя неделя. */
const KEEP_RUNS_PER_SOURCE = 50;

export async function recordImportRun(
  env: Env,
  sourceId: number,
  stats: IntakeStats,
  bytes: number,
  error = "",
): Promise<void> {
  const rejects: Record<string, number> = {};
  for (const [code, count] of Object.entries(stats.rejects)) {
    if (count > 0) rejects[code] = count;
  }

  await run(
    env,
    `INSERT INTO import_runs
       (source_id, ok, bytes, lines, parsed, accepted, publishable, rejects, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sourceId,
    error ? 0 : 1,
    Math.max(0, Math.round(bytes)),
    stats.lines,
    stats.parsed,
    stats.accepted,
    stats.publishable,
    JSON.stringify(rejects).slice(0, 900),
    error ? error.slice(0, 200) : null,
  );

  await run(
    env,
    `DELETE FROM import_runs
      WHERE source_id = ?
        AND id NOT IN (SELECT id FROM import_runs WHERE source_id = ? ORDER BY id DESC LIMIT ?)`,
    sourceId,
    sourceId,
    KEEP_RUNS_PER_SOURCE,
  );
}

export interface ImportRunRow {
  id: number;
  source_id: number;
  ran_at: string;
  ok: number;
  bytes: number;
  lines: number;
  parsed: number;
  accepted: number;
  publishable: number;
  rejects: string;
  error: string | null;
}

/** Последний прогон по каждому источнику — для страницы «Импорт». */
export async function latestRuns(env: Env): Promise<ImportRunRow[]> {
  return await many<ImportRunRow>(
    env,
    `SELECT r.* FROM import_runs r
      WHERE r.id IN (SELECT MAX(id) FROM import_runs GROUP BY source_id)
      ORDER BY r.source_id`,
  );
}

/** Сводка за сутки: сколько всего разобрано и сколько ушло в выдачу. */
export async function runsSummary(
  env: Env,
): Promise<{ runs: number; parsed: number; publishable: number; failed: number }> {
  const row = await many<{ runs: number; parsed: number; publishable: number; failed: number }>(
    env,
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(parsed), 0) AS parsed,
            COALESCE(SUM(publishable), 0) AS publishable,
            COALESCE(SUM(ok = 0), 0) AS failed
       FROM import_runs
      WHERE ran_at >= datetime('now', '-1 day')`,
  );
  return row[0] ?? { runs: 0, parsed: 0, publishable: 0, failed: 0 };
}

/** Пригодится тестам и вызывающему коду: пустая заготовка статистики. */
export function emptyStats(): IntakeStats {
  return { lines: 0, parsed: 0, accepted: 0, publishable: 0, rejects: {} };
}
