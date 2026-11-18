import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(async (..._args: unknown[]) => null as unknown),
  many: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  run: vi.fn(async (..._args: unknown[]) => ({ meta: { changes: 1 } })),
  batch: vi.fn(async (..._args: unknown[]) => undefined),
  logEvent: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../src/db", () => h);

// В Node заголовки ответа обязаны быть ASCII, а боевой заголовок карточки
// подписки начинается с «⚡». Для проверки квоты это не важно — подменяем
// карточку на простой ASCII-вариант.
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
 * Срез по квоте трафика.
 *
 * Квота считается на аккаунт: 10 ГБ — это 10 ГБ на все устройства вместе.
 * Как только расход дошёл до неё, выдача обязана отдать заглушку, даже если
 * серверы берутся из аварийного набора в KV (основная ссылка как раз оттуда).
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

function request(): Request {
  return new Request(`https://vpn.example/sub/${TOKEN}`, {
    headers: { "User-Agent": "Happ/2.9.1" },
  });
}

/**
 * Тело ответа в читаемом виде: JSON-профили отдаются как есть, base64-список
 * и заглушка декодируются в UTF-8 (без Node-типов, через TextDecoder).
 */
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

/** Пользователь, которого увидит выдача подписки. */
function withUser(user: Record<string, unknown>): void {
  h.one.mockImplementation(async (...args: unknown[]) => {
    const sql = String(args[1] ?? "");
    return sql.includes("FROM users") ? user : null;
  });
}

describe("срез по квоте трафика", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("в пределах квоты отдаёт серверы", async () => {
    withUser(baseUser);

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request()));
    expect(body).toContain("1.2.3.4");
  });

  it("после 10 ГБ не отдаёт серверы, даже когда пул лежит в KV", async () => {
    withUser({ ...baseUser, traffic_used_mb: 11 * 1024 });

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request()));
    expect(body).not.toContain("1.2.3.4");
    // Причина попадает в подпись заглушки в URL-кодировке.
    expect(decodeURIComponent(body)).toContain("Трафик 10 ГБ израсходован");
  });

  it("докупленные гигабайты поднимают порог", async () => {
    withUser({ ...baseUser, traffic_used_mb: 11 * 1024, traffic_extra_gb: 5 });

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request()));
    expect(body).toContain("1.2.3.4");
  });

  it("безлимитный тариф не режется по объёму", async () => {
    withUser({ ...baseUser, traffic_gb: 0, traffic_used_mb: 500 * 1024 });

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request()));
    expect(body).toContain("1.2.3.4");
  });

  it("истёкший срок закрывает серверы и говорит, когда закончилось", async () => {
    withUser({ ...baseUser, expires_at: "2026-01-01 00:00:00" });

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request()));
    expect(body).not.toContain("1.2.3.4");
    expect(decodeURIComponent(body)).toContain("Подписка закончилась 01.01.2026");
  });

  it("забаненный аккаунт серверы не получает", async () => {
    withUser({ ...baseUser, status: "banned" });

    const body = await bodyText(await handleSubscription(makeEnv(), TOKEN, request()));
    expect(body).not.toContain("1.2.3.4");
    expect(decodeURIComponent(body)).toContain("Доступ закрыт");
  });
});
