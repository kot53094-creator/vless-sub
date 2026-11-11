import { describe, expect, it } from "vitest";

import { statusPage } from "../src/status_page";
import type { Env } from "../src/types";

/**
 * /status — публичная страница, её дёргают мониторинги. Агрегаты COUNT(*)
 * по всей таблице servers теперь минуту живут в KV: проверяем, что второй
 * заход не читает D1, а при лежащей базе цифры приходят из кэша.
 */

function makeEnv(opts: { rows?: (sql: string) => Array<Record<string, unknown>>; broken?: boolean }) {
  const store = new Map<string, string>();
  let prepareCalls = 0;
  const cache = {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
  const statement = (sql: string) => ({
    all: async () => ({ results: opts.rows?.(sql) ?? [] }),
    first: async () => (opts.rows?.(sql) ?? [])[0] ?? null,
    run: async () => ({}),
  });
  const db = {
    prepare(sql: string) {
      prepareCalls += 1;
      if (opts.broken) throw new Error("d1: daily limit");
      return { bind: () => statement(sql) };
    },
  };
  const env = { CACHE: cache, DB: db } as unknown as Env;
  return { env, store, prepareCalls: () => prepareCalls };
}

const aggregates = (sql: string) =>
  sql.includes("FROM server_checks")
    ? [{ tcp_ok: 4, tcp_fail: 6, tunnel_ok: 7, tunnel_fail: 3 }]
    : [
        {
          servers: 100,
          alive: 50,
          sources: 3,
          published: 20,
          sync_at: "2026-11-11 09:00:00",
          check_at: "2026-11-11 09:05:00",
        },
      ];

describe("страница состояния кэширует агрегаты", () => {
  it("первый заход читает D1 и кладёт цифры в KV, второй — из KV", async () => {
    const { env, store, prepareCalls } = makeEnv({ rows: aggregates });

    const first = await statusPage(env);
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain("Сервис работает");
    expect(html).toContain("из 100");
    expect(store.has("status:counts:v1")).toBe(true);
    const callsAfterFirst = prepareCalls();

    const second = await statusPage(env);
    const html2 = await second.text();
    expect(html2).toContain("из 100");
    expect(prepareCalls()).toBe(callsAfterFirst);
  });

  it("из кэша страница отвечает даже при лежащей базе", async () => {
    const { env, store, prepareCalls } = makeEnv({ broken: true });
    store.set(
      "status:counts:v1",
      JSON.stringify({
        dbOk: true,
        counts: { servers: 42, alive: 21, sources: 3, published: 15 },
        last: { sync_at: "2026-11-11 09:00:00", check_at: "2026-11-11 09:05:00" },
        checks: { tcpOk: 1, tcpFail: 2, tunnelOk: 3, tunnelFail: 4 },
      }),
    );

    const res = await statusPage(env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Сервис работает");
    expect(html).toContain("из 42");
    expect(prepareCalls()).toBe(0);
  });

  it("без кэша и без базы страница честно показывает сбой", async () => {
    const { env } = makeEnv({ broken: true });
    const res = await statusPage(env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("База данных недоступна");
  });
});
