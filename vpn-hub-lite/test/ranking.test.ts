import { describe, expect, it } from "vitest";

import { compareServers, rotateTail } from "../src/ranking";

const REALITY = "vless://uuid@example.invalid:443?security=reality&pbk=K&sni=s&sid=1&fp=chrome";

function server(overrides: Record<string, unknown>) {
  return {
    id: 1,
    link: REALITY,
    visibility: "shareable",
    latency_ms: null,
    priority: 0,
    stability: 0,
    verified_latency_ms: null,
    ...overrides,
  } as Parameters<typeof compareServers>[0];
}

describe("порядок серверов", () => {
  it("проверенный узел выше непроверенного, даже если у того приоритет", () => {
    const working = server({ id: 1, verified_latency_ms: 900 });
    const unverified = server({ id: 2, priority: 50 });
    expect(compareServers(working, unverified)).toBeLessThan(0);
    expect(compareServers(unverified, working)).toBeGreaterThan(0);
  });

  it("проверенный узел выше своего приватного без проверки", () => {
    const working = server({ id: 1, verified_latency_ms: 700 });
    const own = server({ id: 2, visibility: "private", priority: 10 });
    expect(compareServers(working, own)).toBeLessThan(0);
  });

  it("среди работающих первым идёт более быстрый", () => {
    const slow = server({ id: 1, verified_latency_ms: 1200 });
    const fast = server({ id: 2, verified_latency_ms: 250 });
    expect(compareServers(fast, slow)).toBeLessThan(0);
  });

  it("без проверок сохраняется старый порядок по приоритету", () => {
    const low = server({ id: 1, priority: 0 });
    const high = server({ id: 2, priority: 5 });
    expect(compareServers(high, low)).toBeLessThan(0);
  });

  it("провал проверки (0 мс) не считается работой", () => {
    const failed = server({ id: 1, verified_latency_ms: 0, priority: 99 });
    const unverified = server({ id: 2 });
    // Оба без рабочей проверки — решает приоритет.
    expect(compareServers(failed, unverified)).toBeLessThan(0);
  });
});

describe("ротация хвоста списка", () => {
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("закреплённые узлы остаются на месте", () => {
    const rotated = rotateTail(ids, 7, 3);
    expect(rotated.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("состав списка не меняется — меняется только порядок", () => {
    const rotated = rotateTail(ids, 7, 3);
    expect([...rotated].sort((a, b) => a - b)).toEqual(ids);
  });

  it("одна эпоха — один и тот же порядок у всех клиентов", () => {
    expect(rotateTail(ids, 42, 3)).toEqual(rotateTail(ids, 42, 3));
  });

  it("соседние эпохи дают разный порядок", () => {
    const a = rotateTail(ids, 1, 3).join();
    const b = rotateTail(ids, 2, 3).join();
    expect(a).not.toBe(b);
  });

  it("короткий список возвращается как есть", () => {
    expect(rotateTail([1, 2], 5, 3)).toEqual([1, 2]);
    expect(rotateTail([], 5, 3)).toEqual([]);
  });
});
