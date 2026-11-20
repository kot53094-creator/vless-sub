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

/**
 * Якоря в аварийном пути.
 *
 * Основная подписка отдаётся из KV (`pool:rescue:v1`), не из D1: так экономится
 * суточная квота базы. Раньше закреплённые узлы добавлялись только в обычной
 * сборке, и человек получал список без них — после обновления пула это
 * выглядело как «пропали мои серверы». Якоря обязаны быть первыми в любой
 * выдаче, включая KV-резерв и JSON-режимы.
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

function makeEnv(): Env {
  const pool = [
    {
      link: "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=reality&pbk=k&sni=a.com&type=tcp#DE-1",
      blocked_ok: 1,
      host: "1.2.3.4",
    },
  ];
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

function withUser(user: Record<string, unknown>): void {
  h.one.mockImplementation(async (...args: unknown[]) => {
    const sql = String(args[1] ?? "");
    return sql.includes("FROM users") ? user : null;
  });
}

describe("якоря в KV-резерве", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("список ссылок начинается с закреплённых узлов", async () => {
    withUser(baseUser);

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request("v2rayNG/1.9.16")));
    const lines = body.split("\n").filter((line) => line.trim() !== "");
    expect(lines[0]).toContain("golu-gulu");
    expect(lines.slice(0, 10).every((line) => line.includes("golu-gulu"))).toBe(true);
    // Узлы пула при этом остаются ниже — якоря не вытесняют рабочий список.
    expect(body).toContain("1.2.3.4");
  });

  it("мульти-профиль Happ тоже содержит якоря", async () => {
    withUser(baseUser);

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request("Happ/2.9.1")));
    expect(body).toContain("golu-gulu");
    expect(body).toContain("1.2.3.4");
  });

  it("отдельная подписка Hysteria2 остаётся только из QUIC-узлов", async () => {
    withUser(baseUser);

    const body = await bodyText(
      await handleSubscription(makeEnv(), TOKEN, request("v2rayNG/1.9.16"), "hy2"),
    );
    expect(body).not.toContain("golu-gulu");
  });
});
