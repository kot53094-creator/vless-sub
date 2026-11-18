import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(async () => null),
  many: vi.fn(async () => []),
  run: vi.fn(async () => ({ meta: { changes: 1 } })),
  batch: vi.fn(async () => undefined),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => h);

import { deviceLimitOf, trafficLeftGb } from "../src/limits";
import { verifiedMaxAgeHours } from "../src/sub";
import { subscriptionUserinfo } from "../src/premium";
import { handleTraffic } from "../src/traffic_api";
import type { Env } from "../src/types";

/**
 * Лимит устройств и учёт трафика.
 *
 * Проверяем то, что видит человек: сколько устройств разрешено, сколько
 * трафика осталось, и что агент узлов не может ни обойти авторизацию, ни
 * удвоить расход повторной отправкой.
 */

const env = {
  CHECK_TOKEN: "secret-token",
  DEVICE_LIMIT: "2",
} as unknown as Env;

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://vpn.example/api/traffic", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("лимит устройств", () => {
  it("по умолчанию два", () => {
    expect(deviceLimitOf({ device_limit: 0 } as never, env)).toBe(2);
  });

  it("берёт лимит тарифа", () => {
    expect(deviceLimitOf({ device_limit: 5 } as never, env)).toBe(5);
  });

  it("не выходит за разумные рамки", () => {
    expect(deviceLimitOf({ device_limit: 99 } as never, env)).toBe(10);
    expect(deviceLimitOf({ device_limit: -1 } as never, env)).toBe(2);
  });

  it("без пользователя считает по окружению", () => {
    expect(deviceLimitOf(null, env)).toBe(2);
    expect(deviceLimitOf(null, { DEVICE_LIMIT: "4" } as unknown as Env)).toBe(4);
  });
});

describe("окно свежести проверки узла", () => {
  it("по умолчанию трое суток", () => {
    expect(verifiedMaxAgeHours({} as Env)).toBe(72);
  });

  it("настраивается, чтобы не отдавать мёртвые публичные узлы", () => {
    expect(verifiedMaxAgeHours({ VERIFIED_MAX_AGE_H: "6" } as unknown as Env)).toBe(6);
  });

  it("мусор и крайности не ломают отбор", () => {
    expect(verifiedMaxAgeHours({ VERIFIED_MAX_AGE_H: "abc" } as unknown as Env)).toBe(72);
    expect(verifiedMaxAgeHours({ VERIFIED_MAX_AGE_H: "0" } as unknown as Env)).toBe(72);
    expect(verifiedMaxAgeHours({ VERIFIED_MAX_AGE_H: "9999" } as unknown as Env)).toBe(168);
  });
});

describe("остаток трафика", () => {
  it("без квоты остатка нет", () => {
    expect(trafficLeftGb({ traffic_gb: 0, traffic_used_mb: 100 })).toBeNull();
  });

  it("считает в гигабайтах и не уходит в минус", () => {
    expect(trafficLeftGb({ traffic_gb: 10, traffic_used_mb: 512 })).toBe(9.5);
    expect(trafficLeftGb({ traffic_gb: 10, traffic_used_mb: 20 * 1024 })).toBe(0);
  });

  it("расход попадает в заголовок подписки", () => {
    const header = subscriptionUserinfo(
      { traffic_gb: 10, expires_at: "2026-12-01 00:00:00", traffic_used_mb: 1024 },
      { enabled: false, days: 0, trafficGb: 0 },
    );
    expect(header).toContain(`download=${1024 * 1024 ** 2}`);
    expect(header).toContain(`total=${10 * 1024 ** 3}`);
  });
});

describe("приём трафика от агента", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.batch.mockResolvedValue(undefined);
  });

  it("без токена не принимает", async () => {
    const response = await handleTraffic(env, request({ items: [{ token: "t", mb: 5 }] }));
    expect(response.status).toBe(403);
    expect(h.batch).not.toHaveBeenCalled();
  });

  it("принимает пачку и пишет инкремент", async () => {
    const response = await handleTraffic(
      env,
      request(
        { node: "de-1", seq: 10, items: [{ token: "tok_a", mb: 12.5 }, { token: "tok_b", mb: 3 }] },
        { "x-check-token": "secret-token" },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: number };
    expect(body.accepted).toBe(2);
    expect(h.batch).toHaveBeenCalledTimes(1);
    const call = h.batch.mock.calls[0] as unknown as [unknown, Array<{ sql: string; params: unknown[] }>];
    const statements = call[1];
    expect(statements[0].params[0]).toBe(12.5);
    expect(statements[0].params[1]).toBe("tok_a");
  });

  it("игнорирует мусор и отрицательные значения", async () => {
    const response = await handleTraffic(
      env,
      request(
        { items: [{ token: "", mb: 5 }, { token: "tok", mb: -3 }, { token: "tok2", mb: 1 }] },
        { "x-check-token": "secret-token" },
      ),
    );
    const body = (await response.json()) as { accepted: number };
    expect(body.accepted).toBe(1);
  });

  it("не удваивает расход при повторной отправке пачки", async () => {
    const cache = new Map<string, string>();
    const withCache = {
      ...env,
      CACHE: {
        get: async (key: string) => cache.get(key) ?? null,
        put: async (key: string, value: string) => {
          cache.set(key, value);
        },
      },
    } as unknown as Env;

    const first = await handleTraffic(
      withCache,
      request({ node: "de-1", seq: 7, items: [{ token: "tok", mb: 10 }] }, { "x-check-token": "secret-token" }),
    );
    const second = await handleTraffic(
      withCache,
      request({ node: "de-1", seq: 7, items: [{ token: "tok", mb: 10 }] }, { "x-check-token": "secret-token" }),
    );

    expect(((await first.json()) as { accepted: number }).accepted).toBe(1);
    expect(((await second.json()) as { skipped?: string }).skipped).toBe("duplicate");
    expect(h.batch).toHaveBeenCalledTimes(1);
  });
});
