import { afterEach, describe, expect, it, vi } from "vitest";

import { cmdApprove, cmdSetStatus } from "../src/bot/admin";
import { runBackup } from "../src/backup";
import { recordPayment } from "../src/payments";
import type { Env, UserRow } from "../src/types";

/**
 * Журнал выдач (payments, раздел 6 промта). Проверяем не саму таблицу, а
 * поведение выдачи: продление и одобрение оставляют след, урезание доступа —
 * нет, и сбой записи в журнал никогда не ломает саму выдачу.
 */

interface Exec {
  sql: string;
  params: unknown[];
}

function makeEnv(user: Partial<UserRow> = {}) {
  const executed: Exec[] = [];
  const store = new Map<string, string>();
  const cache = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  const row: UserRow = {
    id: 42,
    tg_id: "700000001",
    sub_token: "tok",
    status: "active",
    device_limit: 3,
    expires_at: null,
    ...user,
  } as UserRow;
  const statement = (sql: string, params: unknown[]) => ({
    first: async () => (sql.includes("FROM users") ? row : null),
    run: async () => {
      executed.push({ sql, params });
      return { meta: { last_row_id: 1 } } as never;
    },
    all: async () => ({ results: [] }),
  });
  const db = {
    prepare(sql: string) {
      return {
        bind: (...params: unknown[]) => statement(sql, params),
      };
    },
  };
  const env = {
    CACHE: cache,
    DB: db,
    PUBLIC_BASE_URL: "https://vpn.example",
    BOT_USERNAME: "test_bot",
    ADMIN_TG_ID: "1",
  } as unknown as Env;
  return { env, executed, row };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("журнал выдач payments", () => {
  it("/extend пишет запись с числом дней", async () => {
    const { env, executed } = makeEnv();
    const reply = await cmdSetStatus(env, "700000001", "extend", "14");
    expect(reply).toContain("Продлён");
    const insert = executed.find((item) => item.sql.includes("INSERT INTO payments"));
    expect(insert).toBeDefined();
    expect(insert?.params).toEqual([42, "manual", 14, expect.stringContaining("продление")]);
  });

  it("/approve оставляет след о выдаче", async () => {
    const { env, executed } = makeEnv();
    await cmdApprove(env, "700000001", 30);
    const insert = executed.find((item) => item.sql.includes("INSERT INTO payments"));
    expect(insert?.params[0]).toBe(42);
    expect(insert?.params[2]).toBe(30);
  });

  it("сбой записи в журнал не ломает продление", async () => {
    const { env } = makeEnv();
    const original = env.DB;
    // Первая запись (UPDATE users) проходит, INSERT INTO payments падает.
    let call = 0;
    (env as { DB: unknown }).DB = {
      prepare(sql: string) {
        return {
          bind: (...params: unknown[]) => ({
            first: async () =>
              sql.includes("FROM users")
                ? { id: 42, tg_id: "700000001", sub_token: "tok", status: "active" }
                : null,
            run: async () => {
              call += 1;
              if (sql.includes("INSERT INTO payments")) throw new Error("no such table: payments");
              if (sql.includes("INSERT INTO events")) throw new Error("quota");
              return { meta: {} };
            },
            all: async () => ({ results: [] }),
          }),
        };
      },
    } as never;
    const reply = await cmdSetStatus(env, "700000001", "extend", "7");
    expect(reply).toContain("Продлён");
    (env as { DB: unknown }).DB = original;
    expect(call).toBeGreaterThan(0);
  });

  it("нулевые и отрицательные дни не пишутся", async () => {
    const { env, executed } = makeEnv();
    await recordPayment(env, 42, 0, "ноль");
    await recordPayment(env, 42, -5, "минус");
    expect(executed.find((item) => item.sql.includes("INSERT INTO payments"))).toBeUndefined();
  });

  it("ежедневный бэкап включает таблицу payments", async () => {
    const { env, executed } = makeEnv();
    // Без BOT_TOKEN отправка документа не начинается; подменяем fetch, чтобы
    // проверить именно состав дампа, а не сеть.
    (env as { BOT_TOKEN?: string }).BOT_TOKEN = "test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
    );
    // Отдаем по одной строке на каждую таблицу из списка бэкапа.
    let reads = 0;
    const statement = (sql: string) => ({
      first: async () => null,
      all: async () => {
        // many() идёт через bind().all(), поэтому журнал вызовов ведём здесь.
        executed.push({ sql, params: [] });
        reads += 1;
        return { results: [{ x: reads }] };
      },
      run: async () => ({ meta: {} }),
    });
    (env as { DB: unknown }).DB = {
      prepare(sql: string) {
        return {
          bind: () => statement(sql),
          first: async () => null,
          all: async () => {
            executed.push({ sql, params: [] });
            return { results: [{ x: 1 }] };
          },
          run: async () => ({ meta: {} }),
        };
      },
    } as never;
    // logEvent пишет в events — эта запись здесь тоже пойдёт через run().
    const result = await runBackup(env, true);
    expect(result.ok).toBe(true);
    expect(result.rows).toBeGreaterThan(0);
    expect(executed.some((item) => item.sql.includes("FROM payments"))).toBe(true);
  });
});
