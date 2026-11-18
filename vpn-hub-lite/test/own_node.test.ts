import { describe, expect, it } from "vitest";
import { nodeBlockReason, ownNodeLink, uuidForToken } from "../src/node_clients";
import type { Env, UserRow } from "../src/types";

const TOKEN = "Ej0mbpxIY6-iN8yIvg6g813QXp6N2NqOZzlnSYI_ifE";

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return { SALT: "salt-for-tests", ...overrides } as unknown as Env;
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 1,
    tg_id: 1,
    status: "active",
    sub_token: TOKEN,
    expires_at: "2099-01-01 00:00:00",
    traffic_gb: 10,
    traffic_extra_gb: 0,
    traffic_used_mb: 0,
    ...overrides,
  } as unknown as UserRow;
}

describe("ключ своего узла", () => {
  it("UUID стабилен для одного токена и меняется вместе с ним", async () => {
    const first = await uuidForToken(TOKEN, "salt-for-tests");
    const again = await uuidForToken(TOKEN, "salt-for-tests");
    const other = await uuidForToken("another-token-1234567890", "salt-for-tests");

    expect(first).toBe(again);
    expect(first).not.toBe(other);
  });

  it("похож на UUID v4", async () => {
    const uuid = await uuidForToken(TOKEN, "salt-for-tests");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("без настроенного узла ссылки нет", async () => {
    expect(await ownNodeLink(makeEnv(), makeUser())).toBe("");
  });

  it("собирает персональную ссылку с ключами узла", async () => {
    const env = makeEnv({
      NODE_HOST: "203.0.113.10",
      NODE_PORT: "443",
      NODE_PUBKEY: "PUBKEY123",
      NODE_SID: "ab12cd34",
      NODE_SNI: "okcdn.ru",
      NODE_NAME: "🇷🇺 Россия · свой",
    });
    const link = await ownNodeLink(env, makeUser());
    const uuid = await uuidForToken(TOKEN, "salt-for-tests");

    expect(link.startsWith(`vless://${uuid}@203.0.113.10:443?`)).toBe(true);
    expect(link).toContain("pbk=PUBKEY123");
    expect(link).toContain("sid=ab12cd34");
    expect(link).toContain("sni=okcdn.ru");
    expect(link).toContain("security=reality");
    // Подпись в конце — как её увидит клиент.
    expect(decodeURIComponent(link.split("#")[1])).toBe("🇷🇺 Россия · свой");
  });
});

describe("кому узел выдаёт доступ", () => {
  it("действующая подписка без перерасхода", () => {
    expect(nodeBlockReason(makeUser())).toBe("");
  });

  it("истёкший срок", () => {
    expect(nodeBlockReason(makeUser({ expires_at: "2020-01-01 00:00:00" }))).toBe("expired");
  });

  it("исчерпанная квота на аккаунт", () => {
    expect(nodeBlockReason(makeUser({ traffic_used_mb: 10.2 * 1024 }))).toBe("quota");
  });

  it("докупленные гигабайты поднимают потолок", () => {
    expect(nodeBlockReason(makeUser({ traffic_used_mb: 12 * 1024, traffic_extra_gb: 5 }))).toBe("");
  });

  it("заблокированный аккаунт", () => {
    expect(nodeBlockReason(makeUser({ status: "banned" }))).toBe("status");
  });
});

