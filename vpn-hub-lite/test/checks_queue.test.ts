import { describe, expect, it } from "vitest";

import { handleQueue } from "../src/checks_api";
import type { Env } from "../src/types";

/**
 * Очередь проверок — самый частый читатель D1: агент зовёт её каждый прогон.
 * Здесь проверяем два новых свойства: короткий KV-кэш (повторный вызов не
 * ходит в базу) и резерв из KV-пула, когда база недоступна из-за суточного
 * лимита прочитанных строк.
 */

interface DbOpts {
  rows?: (sql: string) => Array<Record<string, unknown>>;
  broken?: boolean;
}

function makeEnv(opts: DbOpts = {}) {
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
  const env = { CACHE: cache, DB: db, CHECK_TOKEN: "test-token" } as unknown as Env;
  return { env, store, prepareCalls: () => prepareCalls };
}

function queueRequest(params: string): Request {
  return new Request(`https://worker.test/api/checks/queue?${params}`, {
    headers: { "x-check-token": "test-token" },
  });
}

describe("очередь проверок бережёт квоту D1", () => {
  it("второй вызов берёт очередь из KV и не читает базу", async () => {
    const live = [
      { id: 1, link: "vless://u1@live1.example.com:443?type=tcp&security=reality#L1" },
      { id: 2, link: "vless://u2@live2.example.com:443?type=tcp&security=reality#L2" },
      { id: 3, link: "vless://u3@live3.example.com:443?type=tcp&security=reality#L3" },
    ];
    const dead = [{ id: 9, link: "vless://u9@dead.example.com:443?type=tcp&security=reality#D" }];
    const { env, store, prepareCalls } = makeEnv({
      rows: (sql) => (sql.includes("status = 'dead'") ? dead : live),
    });

    const first = await handleQueue(env, queueRequest("limit=5"));
    expect(first.headers.get("x-queue-cache")).toBeNull();
    const body = (await first.json()) as { queue: Array<{ id: number }> };
    expect(body.queue.map((row) => row.id)).toEqual([1, 2, 3, 9]);
    expect(store.has("queue:v1:all:5:")).toBe(true);
    const callsAfterFirst = prepareCalls();

    const second = await handleQueue(env, queueRequest("limit=5"));
    expect(second.headers.get("x-queue-cache")).toBe("hit");
    const cached = (await second.json()) as { queue: Array<{ id: number }> };
    expect(cached.queue.map((row) => row.id)).toEqual([1, 2, 3, 9]);
    expect(prepareCalls()).toBe(callsAfterFirst);
  });

  it("без токена доступа очередь не отдаётся", async () => {
    const { env } = makeEnv();
    const res = await handleQueue(
      env,
      new Request("https://worker.test/api/checks/queue?limit=5"),
    );
    expect(res.status).toBe(403);
  });

  it("ручная проверка одного узла не пишется в общий кэш", async () => {
    const rows = [{ id: 7, link: "vless://u7@single.example.com:443?type=tcp&security=reality#S" }];
    const { env, store, prepareCalls } = makeEnv({ rows: () => rows });

    const first = await handleQueue(env, queueRequest("id=7"));
    const body = (await first.json()) as { queue: Array<{ id: number }> };
    expect(body.queue.map((row) => row.id)).toEqual([7]);
    expect(store.size).toBe(0);

    const second = await handleQueue(env, queueRequest("id=7"));
    expect(second.headers.get("x-queue-cache")).toBeNull();
    expect(prepareCalls()).toBe(2);
  });

  it("при недоступной D1 очередь собирается из KV-пула", async () => {
    const { env, store } = makeEnv({ broken: true });
    store.set(
      "pool:verified:v19",
      JSON.stringify([
        { id: 5, link: "vless://u5@kv-pool.example.com:443?type=tcp&security=reality#KV" },
      ]),
    );

    const res = await handleQueue(env, queueRequest("limit=5"));
    const body = (await res.json()) as { queue: Array<{ id: number; link: string }> };
    expect(body.queue).toHaveLength(1);
    expect(body.queue[0].link).toContain("kv-pool.example.com");
  });

  it("когда нет ни базы, ни пула — очередь пустая, а не ошибка 500", async () => {
    const { env } = makeEnv({ broken: true });
    const res = await handleQueue(env, queueRequest("limit=5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queue: unknown[] };
    expect(body.queue).toEqual([]);
  });
});
