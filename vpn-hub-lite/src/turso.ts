/**
 * Клиент Turso (libSQL) по HTTP.
 *
 * Зачем: D1 на бесплатном тарифе даёт 5 млн прочитанных строк в сутки, и мы
 * в них уже упирались — подписка отдавала заглушку вместо серверов. У Turso
 * лимит на два порядка выше, карта не нужна, а язык тот же SQLite: наши
 * запросы переносятся почти без изменений.
 *
 * Протокол — /v2/pipeline: один POST несёт пачку выражений, ответ приходит
 * массивом результатов в том же порядке.
 */

import type { Env } from "./types";

type Arg =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string };

interface Stmt {
  sql: string;
  args: Arg[];
}

interface PipelineResponse {
  results?: Array<{
    type: string;
    response?: {
      type: "execute";
      result?: { cols: Array<{ name: string }>; rows: Arg[][] };
    };
    error?: { message?: string };
  }>;
}

/** Включён ли Turso: без пары URL+токен молча работаем на D1. */
export function tursoEnabled(env: Env): boolean {
  return Boolean(env.TURSO_URL && env.TURSO_TOKEN);
}

function encodeArg(value: unknown): Arg {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", value: String(value) }
      : { type: "float", value };
  }
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  return { type: "text", value: String(value) };
}

function decodeArg(arg: Arg): unknown {
  switch (arg.type) {
    case "null":
      return null;
    case "integer":
      return Number(arg.value);
    case "float":
      return arg.value;
    default:
      return "value" in arg ? (arg as { value: string }).value : null;
  }
}

async function pipeline(env: Env, statements: Stmt[]): Promise<PipelineResponse["results"]> {
  const url = String(env.TURSO_URL).replace(/\/$/, "");
  const response = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.TURSO_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        ...statements.map((stmt) => ({ type: "execute", stmt })),
        { type: "close" },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`turso http ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as PipelineResponse;
  const failed = data.results?.find((item) => item.error);
  if (failed?.error) throw new Error(`turso: ${failed.error.message ?? "ошибка"}`);
  return data.results;
}

export async function tMany<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const results = await pipeline(env, [{ sql, args: params.map(encodeArg) }]);
  const result = results?.[0]?.response?.result;
  if (!result) return [];
  const names = result.cols.map((col) => col.name);
  return result.rows.map((row) => {
    const item: Record<string, unknown> = {};
    row.forEach((cell, index) => {
      item[names[index]] = decodeArg(cell);
    });
    return item as T;
  });
}

export async function tOne<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const rows = await tMany<T>(env, sql, ...params);
  return rows[0] ?? null;
}

export async function tRun(env: Env, sql: string, ...params: unknown[]): Promise<void> {
  await pipeline(env, [{ sql, args: params.map(encodeArg) }]);
}

/** Пачка выражений одним запросом: экономит и время, и лимиты. */
export async function tBatch(
  env: Env,
  statements: Array<{ sql: string; params: unknown[] }>,
): Promise<void> {
  for (let i = 0; i < statements.length; i += 50) {
    await pipeline(
      env,
      statements.slice(i, i + 50).map((item) => ({
        sql: item.sql,
        args: item.params.map(encodeArg),
      })),
    );
  }
}
