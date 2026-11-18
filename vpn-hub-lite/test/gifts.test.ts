import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(),
  many: vi.fn(async () => []),
  run: vi.fn(async () => ({ meta: { changes: 1 } })),
  logEvent: vi.fn(async () => undefined),
  batch: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => h);

const accrual = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, duplicate: false, hours: 720, expiresAt: "2026-12-14 00:00:00" })),
);
vi.mock("../src/bonus", () => ({ applyAccrual: accrual }));

import { createGift, redeemGift } from "../src/gifts";
import type { Env } from "../src/types";

/**
 * Подарочные коды.
 *
 * Проверяем ровно то, что нельзя чинить вручную: код одноразовый, просроченный
 * не срабатывает, и повторная активация не начисляет дни второй раз.
 */

const env = {} as Env;
const user = { id: 42, tg_id: "700000001" };

beforeEach(() => {
  vi.clearAllMocks();
  h.run.mockResolvedValue({ meta: { changes: 1 } });
  accrual.mockResolvedValue({
    ok: true,
    duplicate: false,
    hours: 720,
    expiresAt: "2026-12-14 00:00:00",
  });
});

describe("создание кода", () => {
  it("делает читаемый код вида XXXX-XXXX", async () => {
    h.one.mockResolvedValue({ id: 1, code: "AB12-CD34", days: 30 });
    const created = await createGift(env, 30, { count: 1 });
    expect(created).toHaveLength(1);
    const inserted = h.run.mock.calls[0] as unknown as [unknown, string, ...unknown[]];
    expect(String(inserted[2])).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("не создаёт код на ноль дней", async () => {
    h.one.mockResolvedValue({ id: 1, code: "AA11-BB22", days: 1 });
    await createGift(env, 0, { count: 1 });
    const call = h.run.mock.calls[0] as unknown as [unknown, string, ...unknown[]];
    expect(Number(call[3])).toBeGreaterThanOrEqual(1);
  });
});

describe("активация", () => {
  it("неизвестный код отклоняется", async () => {
    h.one.mockResolvedValue(null);
    const result = await redeemGift(env, "ZZZZ-ZZZZ", user);
    expect(result.ok).toBe(false);
    expect(accrual).not.toHaveBeenCalled();
  });

  it("активированный код не срабатывает второй раз", async () => {
    h.one.mockResolvedValue({ id: 1, code: "AB12-CD34", days: 30, redeemed_by: 7 });
    const result = await redeemGift(env, "AB12-CD34", user);
    expect(result.ok).toBe(false);
    expect(accrual).not.toHaveBeenCalled();
  });

  it("просроченный код отклоняется до начисления", async () => {
    h.one.mockResolvedValue({
      id: 1,
      code: "AB12-CD34",
      days: 30,
      redeemed_by: null,
      expires_at: "2020-01-01 00:00:00",
    });
    const result = await redeemGift(env, "AB12-CD34", user);
    expect(result.ok).toBe(false);
    expect(accrual).not.toHaveBeenCalled();
  });

  it("успешная активация начисляет дни и пишет ref", async () => {
    h.one.mockResolvedValue({
      id: 1,
      code: "AB12-CD34",
      days: 30,
      redeemed_by: null,
      expires_at: null,
    });
    const result = await redeemGift(env, "ab12-cd34", user);

    expect(result.ok).toBe(true);
    expect(result.days).toBe(30);
    expect(accrual).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ userId: 42, days: 30, ref: "gift:AB12-CD34" }),
    );
  });

  it("проигранная гонка за код не начисляет дни", async () => {
    h.one.mockResolvedValue({ id: 1, code: "AB12-CD34", days: 30, redeemed_by: null });
    h.run.mockResolvedValue({ meta: { changes: 0 } });
    const result = await redeemGift(env, "AB12-CD34", user);
    expect(result.ok).toBe(false);
    expect(accrual).not.toHaveBeenCalled();
  });
});
