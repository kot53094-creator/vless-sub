import { describe, expect, it } from "vitest";

import { pickBest } from "../src/sub";
import type { DeliverableServer } from "../src/types";

function node(id: number, minutesAgo: number, latency: number, speed = 0): DeliverableServer {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace("T", " ").slice(0, 19);
  return {
    id,
    link: `vless://uuid@host${id}:443#n${id}`,
    host: `host${id}`,
    port: 443,
    status: "alive",
    verified_at: ts,
    verified_latency_ms: latency,
    speed_mbps: speed,
    country_code: "DE",
    country_name: "Германия",
    enabled: 1,
    tier: "public",
  } as unknown as DeliverableServer;
}

describe("лучший сервер", () => {
  it("берёт свежий узел с меньшим пингом", () => {
    const list = [node(1, 5, 400), node(2, 10, 120), node(3, 60, 200)];
    expect(pickBest(list)?.id).toBe(2);
  });

  it("при равном пинге выбирает более быстрый", () => {
    const list = [node(1, 5, 100, 5), node(2, 5, 100, 25)];
    expect(pickBest(list)?.id).toBe(2);
  });

  it("пропускает закреплённый блок и пустой список не ломает", () => {
    expect(pickBest([], 0)).toBeNull();
    expect(pickBest([node(1, 5, 90), node(2, 5, 150)], 1)?.id)
      .toBe(2);
  });

  it("если свежих нет — берёт лучший из старых", () => {
    const list = [node(1, 60 * 48, 700), node(2, 60 * 24 * 3, 120)];
    expect(pickBest(list)?.id).toBe(2);
  });
});
