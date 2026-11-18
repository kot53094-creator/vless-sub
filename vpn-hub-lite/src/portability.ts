/**
 * Переносимость базы: списки таблиц, портируемый SQL и манифест дампа.
 *
 * Задача модуля — чтобы «переехать на другого провайдера» было операцией,
 * а не проектом. Здесь только чистые функции: их проверяют тесты, а не
 * живая база. Работа с самой базой — в `export_api.ts`.
 *
 * Диалекты:
 * - `sqlite` — D1 и Turso/libSQL (текущий и ближайший резервный провайдер);
 * - `postgres` — Neon/Supabase на случай переезда (другой синтаксис
 *   плейсхолдеров и `ON CONFLICT`).
 */

/**
 * Порядок восстановления: справочники раньше связей, иначе внешние ключи
 * не дадут вставить строку. История проверок — последней: она самая большая
 * и на работу сервиса не влияет.
 */
export const RESTORE_ORDER = [
  "settings",
  "sources",
  "pools",
  "servers",
  "pool_servers",
  "users",
  "user_pools",
  "user_sources",
  "assignments",
  "plans",
  "payments",
  "promos",
  "promo_uses",
  "accruals",
  "daily_claims",
  "referrals",
  "invites",
  "user_devices",
  "user_squads",
  "sub_versions",
  "banners",
  "notify_log",
  "import_runs",
  "server_checks",
  "fetch_log",
  "events",
  "user_presence",
  "bot_state",
] as const;

export type TableName = (typeof RESTORE_ORDER)[number];

/**
 * Без этих таблиц восстановление бессмысленно: нет людей или серверов.
 * Остальные можно догрузить позже.
 */
export const CRITICAL_TABLES: TableName[] = [
  "settings",
  "sources",
  "servers",
  "users",
  "plans",
  "payments",
  "promos",
  "referrals",
];

export interface TableDump {
  name: string;
  columns: string[];
  rows: unknown[][];
  /** Сколько строк реально в таблице (может быть больше выгруженного). */
  total?: number;
}

export interface ExportManifest {
  format: "apelsinka-export";
  version: 1;
  createdAt: string;
  source: "d1" | "turso";
  tables: Array<{ name: string; rows: number; total: number | null }>;
  rows: number;
  criticalComplete: boolean;
}

export type Dialect = "sqlite" | "postgres";

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/** Имя таблицы/колонки попадает в SQL только после проверки. */
export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`недопустимое имя: ${name}`);
  return `"${name}"`;
}

/** Литерал значения. Строки экранируются удвоением кавычки. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) {
    return `X'${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * INSERT для одной строки.
 *
 * `sqlite`: `INSERT OR REPLACE` — повторный прогон не падает на дублях.
 * `postgres`: `ON CONFLICT DO NOTHING` — то же поведение, но без потери
 * чужих изменений (REPLACE в Postgres не существует).
 */
export function insertStatement(
  table: string,
  columns: string[],
  row: unknown[],
  dialect: Dialect = "sqlite",
): string {
  if (columns.length === 0) throw new Error("нет колонок");
  if (row.length !== columns.length) {
    throw new Error(`${table}: ${row.length} значений на ${columns.length} колонок`);
  }
  const cols = columns.map(quoteIdent).join(", ");
  const values = row.map(sqlLiteral).join(", ");
  const head =
    dialect === "postgres"
      ? `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${values}) ON CONFLICT DO NOTHING;`
      : `INSERT OR REPLACE INTO ${quoteIdent(table)} (${cols}) VALUES (${values});`;
  return head;
}

/** Дамп таблицы целиком — по строке на INSERT: читаемо и правится руками. */
export function tableSql(dump: TableDump, dialect: Dialect = "sqlite"): string {
  const head = `-- ${dump.name}: ${dump.rows.length} строк`;
  const body = dump.rows.map((row) => insertStatement(dump.name, dump.columns, row, dialect));
  return [head, ...body].join("\n");
}

/** Полный SQL-дамп: заголовок с манифестом и все таблицы по порядку. */
export function dumpToSql(
  dumps: TableDump[],
  manifest: ExportManifest,
  dialect: Dialect = "sqlite",
): string {
  const header = [
    `-- Апельсинка VPN: дамп базы (${dialect})`,
    `-- создан: ${manifest.createdAt}`,
    `-- источник: ${manifest.source}`,
    `-- строк: ${manifest.rows}`,
    `-- ВНИМАНИЕ: содержит токены подписки и ссылки источников.`,
    "",
    "BEGIN;",
  ].join("\n");
  const ordered = [...dumps].sort(
    (a, b) => RESTORE_ORDER.indexOf(a.name as TableName) - RESTORE_ORDER.indexOf(b.name as TableName),
  );
  return [header, ...ordered.map((dump) => tableSql(dump, dialect)), "COMMIT;", ""].join("\n");
}

/** Манифест: по нему видно, что выгрузилось, а что потерялось. */
export function buildManifest(
  dumps: TableDump[],
  source: "d1" | "turso",
  createdAt = new Date().toISOString(),
): ExportManifest {
  const tables = dumps.map((dump) => ({
    name: dump.name,
    rows: dump.rows.length,
    total: dump.total ?? null,
  }));
  const present = new Set(dumps.filter((dump) => dump.rows.length > 0).map((dump) => dump.name));
  return {
    format: "apelsinka-export",
    version: 1,
    createdAt,
    source,
    tables,
    rows: tables.reduce((sum, item) => sum + item.rows, 0),
    criticalComplete: CRITICAL_TABLES.every((name) => present.has(name)),
  };
}

/**
 * Сверка «до/после»: перенос считается удачным только если по каждой
 * критичной таблице число строк совпало. Молча «залилось» — не результат.
 */
export function verifyCounts(
  expected: Array<{ name: string; rows: number }>,
  actual: Array<{ name: string; rows: number }>,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const map = new Map(actual.map((item) => [item.name, item.rows]));
  for (const table of expected) {
    if (!(CRITICAL_TABLES as string[]).includes(table.name) && table.rows === 0) continue;
    const got = map.get(table.name);
    if (got === undefined) {
      problems.push(`${table.name}: таблица не найдена`);
      continue;
    }
    if (got !== table.rows) problems.push(`${table.name}: было ${table.rows}, стало ${got}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Пачки строк: крупная таблица не должна упираться в лимит батча. */
export function chunkRows<T>(rows: T[], size = 100): T[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += step) chunks.push(rows.slice(i, i + step));
  return chunks;
}

/** Какие таблицы выгружать по запросу `?tables=critical|all`. */
export function resolveTables(scope: string | null): TableName[] {
  if (scope === "critical") return [...CRITICAL_TABLES];
  return [...RESTORE_ORDER];
}
