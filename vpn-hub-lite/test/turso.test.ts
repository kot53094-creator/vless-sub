import { afterEach, describe, expect, it, vi } from "vitest";

import { batch, many, run } from "../src/db";
import { tBatch, tMany, tOne, tRun, tursoEnabled } from "../src/turso";
import type { Env } from "../src/types";

/**
 * Turso/libSQL — резервная база на случай, если D1 упирается в суточную
 * квоту. Здесь проверяется протокол /v2/pipeline и то, что переключение
 * пары секретов действительно уводит и чтение, и запись из D1.
 */

function pipelineBody(rows: unknown[][], cols: string[]) {
  return {
    results: [
      {
        type: "ok",
        response: {
          type: "execute",
          result: {
            cols: cols.map((name) => ({ name })),
            rows,
          },
        },
      },
      { type: "ok", response: { type: "close" } },
    ],
  };
}

function stubFetch(payload: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function makeEnv(extra: Record<string, unknown> = {}) {
  const db = {
    prepare() {
      throw new Error("D1 не должен вызываться при включённом Turso");
    },
  };
  const cache = {
    async get() {
      return null;
    },
    async put() {
      return undefined;
    },
    async delete() {
      return true;
    },
  };
  return {
    TURSO_URL: "libsql://vpn-hub.turso.io/",
    TURSO_TOKEN: "secret-token",
    DB: db,
    CACHE: cache,
    ...extra,
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Turso включается только парой секретов", () => {
  it("без URL или без токена работает D1", () => {
    expect(tursoEnabled({} as Env)).toBe(false);
    expect(tursoEnabled({ TURSO_URL: "libsql://x" } as Env)).toBe(false);
    expect(tursoEnabled({ TURSO_TOKEN: "t" } as Env)).toBe(false);
    expect(tursoEnabled({ TURSO_URL: "libsql://x", TURSO_TOKEN: "t" } as Env)).toBe(true);
  });
});

describe("протокол libSQL", () => {
  it("отправляет pipeline на /v2/pipeline с Bearer-токеном", async () => {
    const spy = stubFetch(pipelineBody([[{ type: "integer", value: "7" }]], ["id"]));

    const rows = await tMany<{ id: number }>(makeEnv(), "SELECT id FROM users WHERE tg_id = ?", "42");

    expect(rows).toEqual([{ id: 7 }]);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("libsql://vpn-hub.turso.io/v2/pipeline");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    const body = JSON.parse(String(init.body)) as {
      requests: Array<{ type: string; stmt?: { sql: string; args: unknown[] } }>;
    };
    expect(body.requests[0].stmt?.sql).toBe("SELECT id FROM users WHERE tg_id = ?");
    expect(body.requests[0].stmt?.args).toEqual([{ type: "text", value: "42" }]);
    expect(body.requests.at(-1)?.type).toBe("close");
  });

  it("декодирует null, числа и текст", async () => {
    stubFetch(
      pipelineBody(
        [
          [
            { type: "integer", value: "5" },
            { type: "null" },
            { type: "text", value: "ok" },
            { type: "float", value: 1.5 },
          ],
        ],
        ["id", "note", "status", "speed"],
      ),
    );

    const rows = await tMany<Record<string, unknown>>(makeEnv(), "SELECT 1");
    expect(rows[0]).toEqual({ id: 5, note: null, status: "ok", speed: 1.5 });
  });

  it("tOne возвращает первую строку или null", async () => {
    stubFetch(pipelineBody([[{ type: "text", value: "x" }]], ["v"]));
    expect(await tOne<{ v: string }>(makeEnv(), "SELECT v")).toEqual({ v: "x" });

    stubFetch(pipelineBody([], ["v"]));
    expect(await tOne(makeEnv(), "SELECT v")).toBeNull();
  });

  it("ошибка HTTP и ошибка выражения не проглатываются", async () => {
    stubFetch({ error: "nope" }, 500);
    await expect(tRun(makeEnv(), "SELECT 1")).rejects.toThrow(/turso http 500/);

    stubFetch({
      results: [{ type: "error", error: { message: "no such table: users" } }],
    });
    await expect(tRun(makeEnv(), "SELECT 1")).rejects.toThrow(/no such table/);
  });

  it("tBatch режет пачку по 50 выражений", async () => {
    const spy = stubFetch(pipelineBody([], []));
    const statements = Array.from({ length: 51 }, (_, i) => ({
      sql: "INSERT INTO t (id) VALUES (?)",
      params: [i],
    }));

    await tBatch(makeEnv(), statements);

    expect(spy).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const second = JSON.parse(String((spy.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(first.requests).toHaveLength(51); // 50 выражений + close
    expect(second.requests).toHaveLength(2); // 1 выражение + close
  });
});

describe("слой db.ts переключается целиком", () => {
  it("run пишет в Turso, а не в D1", async () => {
    const spy = stubFetch(pipelineBody([], []));
    const env = makeEnv();

    const result = await run(env, "UPDATE users SET status = ? WHERE id = ?", "active", 1);

    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.requests[0].stmt.sql).toContain("UPDATE users");
    expect(body.requests[0].stmt.args).toEqual([
      { type: "text", value: "active" },
      { type: "integer", value: "1" },
    ]);
  });

  it("batch и many идут через один pipeline, D1 не трогается", async () => {
    const spy = stubFetch(pipelineBody([[{ type: "integer", value: "3" }]], ["n"]));
    const env = makeEnv();

    await batch(env, [
      { sql: "INSERT INTO a (id) VALUES (?)", params: [1] },
      { sql: "INSERT INTO a (id) VALUES (?)", params: [2] },
    ]);
    const rows = await many<{ n: number }>(env, "SELECT COUNT(*) AS n FROM a");

    expect(rows).toEqual([{ n: 3 }]);
    expect(spy).toHaveBeenCalledTimes(2);
    const batchBody = JSON.parse(
      String((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(batchBody.requests).toHaveLength(3); // 2 выражения + close
  });
});
