import { describe, expect, it } from "vitest";
import {
  buildManifest,
  chunkRows,
  dumpToSql,
  insertStatement,
  quoteIdent,
  resolveTables,
  sqlLiteral,
  verifyCounts,
  type TableDump,
} from "../src/portability";

const dump = (name: string, rows: unknown[][] = [], columns = ["id"]): TableDump => ({
  name,
  columns,
  rows,
});

describe("sqlLiteral", () => {
  it("экранирует кавычки, а не ломает SQL", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'");
  });

  it("null и NaN превращаются в NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
    expect(sqlLiteral(Number.NaN)).toBe("NULL");
  });

  it("числа и булевы без кавычек", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(0)).toBe("0");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
  });

  it("объект сохраняется как JSON", () => {
    expect(sqlLiteral({ a: 1 })).toBe("'{\"a\":1}'");
  });
});

describe("quoteIdent", () => {
  it("пропускает нормальные имена", () => {
    expect(quoteIdent("server_checks")).toBe('"server_checks"');
  });

  it("не пропускает инъекцию через имя", () => {
    expect(() => quoteIdent('users"; DROP TABLE users; --')).toThrow();
    expect(() => quoteIdent("users--")).toThrow();
  });
});

describe("insertStatement", () => {
  it("sqlite использует INSERT OR REPLACE", () => {
    const sql = insertStatement("users", ["id", "name"], [1, "Аня"], "sqlite");
    expect(sql).toBe(`INSERT OR REPLACE INTO "users" ("id", "name") VALUES (1, 'Аня');`);
  });

  it("postgres использует ON CONFLICT DO NOTHING", () => {
    const sql = insertStatement("users", ["id"], [1], "postgres");
    expect(sql).toContain("INSERT INTO \"users\"");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toContain("OR REPLACE");
  });

  it("несовпадение колонок и значений — ошибка, а не тихая потеря", () => {
    expect(() => insertStatement("users", ["id", "name"], [1], "sqlite")).toThrow();
  });
});

describe("dumpToSql", () => {
  it("ставит таблицы в порядке восстановления", () => {
    const sql = dumpToSql(
      [dump("users", [[2]]), dump("settings", [[1]])],
      buildManifest([], "d1"),
    );
    expect(sql.indexOf('"settings"')).toBeLessThan(sql.indexOf('"users"'));
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });

  it("предупреждает о секретах в шапке", () => {
    const sql = dumpToSql([dump("users", [[1]])], buildManifest([], "d1"));
    expect(sql).toContain("токены подписки");
  });
});

describe("buildManifest", () => {
  it("считает строки и отмечает полноту критичных таблиц", () => {
    const manifest = buildManifest(
      [
        dump("settings", [[1]]),
        dump("sources", [[1]]),
        dump("servers", [[1]]),
        dump("users", [[1]]),
        dump("plans", [[1]]),
        dump("payments", [[1]]),
        dump("promos", [[1]]),
        dump("referrals", [[1]]),
      ],
      "d1",
      "2026-11-11T00:00:00.000Z",
    );
    expect(manifest.rows).toBe(8);
    expect(manifest.criticalComplete).toBe(true);
  });

  it("без users полнота не подтверждается", () => {
    const manifest = buildManifest([dump("settings", [[1]])], "turso");
    expect(manifest.criticalComplete).toBe(false);
    expect(manifest.source).toBe("turso");
  });
});

describe("verifyCounts", () => {
  it("совпадение по всем таблицам — успех", () => {
    const result = verifyCounts(
      [{ name: "users", rows: 10 }, { name: "servers", rows: 5 }],
      [{ name: "users", rows: 10 }, { name: "servers", rows: 5 }],
    );
    expect(result.ok).toBe(true);
  });

  it("потеря строк видна поимённо", () => {
    const result = verifyCounts(
      [{ name: "users", rows: 10 }, { name: "servers", rows: 5 }],
      [{ name: "users", rows: 7 }, { name: "servers", rows: 5 }],
    );
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("users: было 10, стало 7");
  });

  it("отсутствующая таблица — проблема, а не ноль", () => {
    const result = verifyCounts([{ name: "users", rows: 3 }], []);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("не найдена");
  });
});

describe("chunkRows", () => {
  it("режет по размеру и не теряет хвост", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("нулевой размер не вешает цикл", () => {
    expect(chunkRows([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("resolveTables", () => {
  it("critical — только необходимое", () => {
    const keys = resolveTables("critical");
    expect(keys).toContain("users");
    expect(keys).not.toContain("server_checks");
  });

  it("all — вся схема", () => {
    expect(resolveTables("all")).toContain("server_checks");
    expect(resolveTables(null).length).toBeGreaterThan(20);
  });
});
