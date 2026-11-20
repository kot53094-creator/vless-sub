import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(async (..._args: unknown[]) => null as unknown),
  many: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  run: vi.fn(async (..._args: unknown[]) => ({ meta: { changes: 1 } })),
  batch: vi.fn(async (..._args: unknown[]) => undefined),
  logEvent: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../src/db", () => h);

vi.mock("../src/premium", async () => {
  const actual = await vi.importActual<typeof import("../src/premium")>("../src/premium");
  return {
    ...actual,
    premiumHeaders: () => ({ "profile-title": "test", "profile-update-interval": "12" }),
  };
});

import { handleSubscription } from "../src/sub";
import type { Env } from "../src/types";
import type { SubMode } from "../src/sub";

/**
 * Выдача из аварийного пула KV (`pool:rescue:v1`) — основной путь подписки.
 *
 * Проверяем три вещи, которые ломались в бою:
 *   1) плоский список — только VLESS, без дублей по host:port и не длиннее 30;
 *   2) «Авто» берёт только проверенные и быстрые узлы, проба идёт по IP;
 *   3) HY2 забирается из всего пула, а не из первых тридцати строк.
 */

const TOKEN = "Ej0mbpxIY6-iN8yIvg6g813QXp6N2NqOZzlnSYI_ifE";

const baseUser = {
  id: 1,
  tg_id: 5680608085,
  status: "active",
  tier: "premium",
  sub_token: TOKEN,
  expires_at: "2099-01-01 00:00:00",
  device_limit: 3,
  traffic_gb: 10,
  traffic_extra_gb: 0,
  traffic_used_mb: 0,
  created_at: "2026-01-01 00:00:00",
  note: "",
};

interface Row {
  link: string;
  blocked_ok?: number;
  speed_mbps?: number;
  host?: string;
}

function vless(host: string, uuid = "11111111-2222-3333-4444-555555555555"): Row {
  return {
    link: `vless://${uuid}@${host}:443?security=reality&pbk=k&sni=a.com&type=tcp#${host}`,
    host,
  };
}

function makeEnv(pool: Row[]): Env {
  return {
    PUBLIC_BASE_URL: "https://vpn.example",
    SALT: "salt",
    STRICT_WORKING: "1",
    CACHE: {
      get: async (key: string) => (key === "pool:rescue:v1" ? pool : null),
      put: async () => undefined,
      delete: async () => undefined,
    },
    DB: {},
  } as unknown as Env;
}

function request(userAgent: string): Request {
  return new Request(`https://vpn.example/sub/${TOKEN}`, {
    headers: { "User-Agent": userAgent },
  });
}

async function bodyText(response: Response): Promise<string> {
  const type = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  if (type.includes("json")) return raw;
  try {
    const binary = atob(raw.trim());
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return raw;
  }
}

async function fetchBody(pool: Row[], mode: SubMode = "default", ua = "v2rayNG/1.9.16") {
  h.one.mockImplementation(async (...args: unknown[]) => {
    const sql = String(args[1] ?? "");
    return sql.includes("FROM users") ? baseUser : null;
  });
  return bodyText(await handleSubscription(makeEnv(pool), TOKEN, request(ua), mode));
}

describe("выдача из пула KV", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("плоский список: только VLESS, без дублей и не длиннее 30", async () => {
    const pool: Row[] = [
      vless("dup.example.com"),
      vless("dup.example.com", "99999999-2222-3333-4444-555555555555"),
      ...Array.from({ length: 31 }, (_, i) => vless(`n${i}.example.com`)),
      { link: "hysteria2://secret@hy.example.com:8443?sni=hy.example.com#hy" },
    ];
    const body = await fetchBody(pool);
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);

    expect(lines).toHaveLength(30);
    expect(lines.every((l) => l.startsWith("vless://"))).toBe(true);
    expect(body).not.toContain("hysteria2://");
    expect(body).not.toContain("golu-gulu");
    const hosts = lines.map((l) => l.split("@")[1]?.split("?")[0]);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it("«Авто» берёт только быстрые проверенные узлы и пробует сеть по IP", async () => {
    const pool: Row[] = [
      { ...vless("slow.example.com"), blocked_ok: 1, speed_mbps: 0.5 },
      { ...vless("fast.example.com"), blocked_ok: 1, speed_mbps: 12 },
      { ...vless("unfiltered.example.com"), blocked_ok: 0, speed_mbps: 90 },
      { ...vless("dup.example.com"), blocked_ok: 1, speed_mbps: 20 },
      { ...vless("dup.example.com"), blocked_ok: 1, speed_mbps: 20 },
    ];
    const body = await fetchBody(pool, "auto", "Happ/2.9.1");
    const config = JSON.parse(body) as {
      routing: { balancers: { tag: string; selector: string[]; fallbackTag: string }[] };
      observatory: { probeUrl: string };
      burstObservatory: { pingConfig: { destination: string } };
    };
    const balancer = config.routing.balancers[0];

    expect(balancer.selector.join(" ")).toContain("fast.example.com");
    expect(balancer.selector.join(" ")).not.toContain("slow.example.com");
    expect(balancer.selector.join(" ")).not.toContain("unfiltered.example.com");
    expect(balancer.fallbackTag).toBe(balancer.selector[0]);
    expect(config.observatory.probeUrl).toBe("https://1.1.1.1/cdn-cgi/trace");
    expect(config.burstObservatory.pingConfig.destination).toBe("https://1.1.1.1/cdn-cgi/trace");
  });

  it("HY2 берётся из всего пула, а не из видимых тридцати строк", async () => {
    const pool: Row[] = [
      ...Array.from({ length: 40 }, (_, i) => vless(`n${i}.example.com`)),
      { link: "hysteria2://secret@hy.example.com:8443?sni=hy.example.com#hy" },
    ];
    const body = await fetchBody(pool, "hy2");
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("hysteria2://secret@hy.example.com:8443");
  });
});
