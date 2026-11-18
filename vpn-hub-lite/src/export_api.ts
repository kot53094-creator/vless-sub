/**
 * Экспорт базы для переноса на другого провайдера.
 *
 * Почему отдельный модуль, а не `backup.ts`: бэкап — это «сохранить копию
 * в Telegram», а экспорт — «забрать данные и залить в другую базу».
 * Требования разные: экспорту нужны все таблицы, читаемые имена колонок,
 * SQL-дамп и манифест, по которому видно недоехавшее.
 *
 * Ограничение Worker — 50 подзапросов на вызов. Поэтому у модуля есть
 * бюджет запросов: лучше честно показать `skipped`, чем упасть на середине
 * и оставить админа с неполным дампом без предупреждения.
 */

import { many } from "./db";
import { tursoEnabled } from "./turso";
import {
  buildManifest,
  dumpToSql,
  quoteIdent,
  resolveTables,
  type Dialect,
  type ExportManifest,
  type TableDump,
  type TableName,
} from "./portability";
import type { Env } from "./types";

/** Потолок строк на таблицу за один вызов: защита от гигантского ответа. */
const MAX_ROWS_PER_TABLE = 20_000;
/** Бюджет подзапросов: 50 — лимит платформы, оставляем запас. */
const QUERY_BUDGET = 40;

export interface ExportResult {
  manifest: ExportManifest;
  tables: TableDump[];
  skipped: string[];
  truncated: string[];
}

async function columnsOf(env: Env, table: TableName): Promise<string[]> {
  const rows = await many<{ name: string }>(env, `PRAGMA table_info(${quoteIdent(table)})`);
  return rows.map((row) => row.name);
}

async function dumpTable(
  env: Env,
  table: TableName,
  budget: { left: number },
): Promise<TableDump | null> {
  if (budget.left <= 0) return null;
  try {
    budget.left -= 1;
    const objects = await many<Record<string, unknown>>(
      env,
      `SELECT * FROM ${quoteIdent(table)} LIMIT ${MAX_ROWS_PER_TABLE}`,
    );
    let columns = objects.length > 0 ? Object.keys(objects[0]) : [];
    if (columns.length === 0) {
      if (budget.left <= 0) return { name: table, columns: [], rows: [] };
      budget.left -= 1;
      columns = await columnsOf(env, table);
    }
    return {
      name: table,
      columns,
      rows: objects.map((row) => columns.map((column) => row[column] ?? null)),
    };
  } catch {
    // Нет таблицы в этой версии схемы — это не ошибка экспорта.
    return null;
  }
}

/**
 * Снять дамп.
 *
 * `scope`: `critical` — только то, без чего не восстановить сервис;
 * `all` — вся схема, включая историю проверок.
 */
export async function exportDatabase(
  env: Env,
  scope: "critical" | "all" = "critical",
): Promise<ExportResult> {
  const tables = resolveTables(scope);
  const budget = { left: QUERY_BUDGET };
  const dumps: TableDump[] = [];
  const skipped: string[] = [];
  const truncated: string[] = [];

  for (const table of tables) {
    const dump = await dumpTable(env, table, budget);
    if (!dump) {
      skipped.push(table);
      continue;
    }
    if (dump.rows.length >= MAX_ROWS_PER_TABLE) truncated.push(table);
    dumps.push(dump);
  }

  return {
    manifest: buildManifest(dumps, tursoEnabled(env) ? "turso" : "d1"),
    tables: dumps,
    skipped,
    truncated,
  };
}

/** Тот же дамп в виде SQL-файла: `sqlite` для Turso, `postgres` для Neon. */
export function exportAsSql(result: ExportResult, dialect: Dialect): string {
  return dumpToSql(result.tables, result.manifest, dialect);
}

/** Ответ для скачивания: JSON или SQL, с именем файла по дате. */
export function exportResponse(result: ExportResult, format: "json" | "sql", dialect: Dialect): Response {
  const stamp = result.manifest.createdAt.slice(0, 19).replace(/[:T]/g, "-");
  if (format === "sql") {
    return new Response(exportAsSql(result, dialect), {
      status: 200,
      headers: {
        "content-type": "application/sql; charset=utf-8",
        "content-disposition": `attachment; filename="apelsinka-${stamp}.sql"`,
        "cache-control": "no-store",
      },
    });
  }
  // Формат совместим с tools/restore-backup.mjs: `tables` — объект
  // «имя таблицы → массив строк-объектов». Один и тот же файл читают и
  // восстановление, и перенос в другую базу.
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const dump of result.tables) {
    if (dump.rows.length === 0) {
      tables[dump.name] = [];
      continue;
    }
    tables[dump.name] = dump.rows.map((row) =>
      Object.fromEntries(dump.columns.map((column, index) => [column, row[index] ?? null])),
    );
  }
  return new Response(
    JSON.stringify(
      {
        kind: "apelsinka-export",
        created_at: result.manifest.createdAt,
        source: result.manifest.source,
        manifest: result.manifest,
        skipped: result.skipped,
        truncated: result.truncated,
        tables,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="apelsinka-${stamp}.json"`,
        "cache-control": "no-store",
      },
    },
  );
}
