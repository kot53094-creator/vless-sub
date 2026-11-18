import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(),
  many: vi.fn(async () => []),
  run: vi.fn(async () => ({ meta: { changes: 1 } })),
  logEvent: vi.fn(async () => undefined),
  batch: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => h);
vi.mock("../src/bonus", () => ({ applyAccrual: vi.fn(async () => ({ ok: true, duplicate: false, expiresAt: null })) }));
vi.mock("../src/payments", () => ({ recordsPayment: vi.fn(async () => undefined) }));

import { isPurchasable, isTrafficPack, markOrderPaid } from "../src/orders";
import { packAsPlan, listTrafficPacks } from "../src/traffic_packs";
import { trafficQuotaGb } from "../src/limits";
import type { Env } from "../src/types";
import type { OrderRow } from "../src/pay/types";

/**
 * Докупка трафика.
 *
 * Ключевое отличие от тарифа: пакет не двигает дату окончания, а увеличивает
 * квоту. Если это перепутать, человек заплатит за гигабайты и получит дни.
 */

const env = {} as Env;

function packOrder(): OrderRow {
  return {
    id: 9,
    public_id: "ord_gb50",
    user_id: 42,
    plan_code: "gb50",
    plan_title: "+50 ГБ",
    days: 0,
    device_limit: null,
    traffic_gb: null,
    amount_rub: 349,
    amount_minor: 34900,
    currency: "RUB",
    provider: "yookassa",
    status: "pending",
    external_id: null,
    telegram_charge_id: null,
    provider_charge_id: null,
    promo_code: "",
    note: "",
    created_at: "2026-11-14 10:00:00",
    updated_at: "2026-11-14 10:00:00",
    paid_at: null,
    refunded_at: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.run.mockResolvedValue({ meta: { changes: 1 } });
});

describe("распознавание пакета", () => {
  it("код gb50 — пакет, month — нет", () => {
    expect(isTrafficPack("gb50")).toBe(true);
    expect(isTrafficPack("gb10")).toBe(true);
    expect(isTrafficPack("month")).toBe(false);
    expect(isTrafficPack("gb")).toBe(false);
  });

  it("пакет можно купить, хотя дней ноль", () => {
    expect(isPurchasable({ code: "gb50", title: "+50 ГБ", days: 0, price_rub: 349 })).toBe(true);
    expect(isPurchasable({ code: "empty", title: "", days: 0, price_rub: 0 })).toBe(false);
  });

  it("пакет превращается в план кассы без дней", () => {
    const plan = packAsPlan({ code: "gb50", gb: 50, price_rub: 349, title: "+50 ГБ" });
    expect(plan.days).toBe(0);
    expect(plan.price_rub).toBe(349);
  });
});

describe("квота", () => {
  it("складывает тариф и докупку", () => {
    expect(trafficQuotaGb({ traffic_gb: 10, traffic_extra_gb: 5 })).toBe(15);
  });

  it("без базовой квоты докупка не делает лимит", () => {
    expect(trafficQuotaGb({ traffic_gb: 0, traffic_extra_gb: 50 })).toBeNull();
  });
});

describe("оплата пакета", () => {
  it("начисляет гигабайты, а не дни", async () => {
    h.one.mockResolvedValue(packOrder());
    const result = await markOrderPaid(env, "ord_gb50", {
      externalId: "pay_9",
      currency: "RUB",
      amountMinor: 34900,
    });

    expect(result.ok).toBe(true);
    const update = (h.run.mock.calls as unknown as Array<[unknown, string, ...unknown[]]>).find(
      (call) => call[1].includes("traffic_extra_gb"),
    );
    expect(update).toBeDefined();
    expect(update?.[2]).toBe(50);
  });
});

describe("витрина пакетов", () => {
  it("пустой список, если миграция не применена", async () => {
    h.many.mockRejectedValue(new Error("no such table"));
    expect(await listTrafficPacks(env)).toEqual([]);
  });

  it("отдаёт активные пакеты", async () => {
    h.many.mockResolvedValue([
      { code: "gb10", gb: 10, price_rub: 99, title: "+10 ГБ" },
      { code: "gb0", gb: 0, price_rub: 10, title: "битый" },
    ] as never);
    const packs = await listTrafficPacks(env);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.code).toBe("gb10");
  });
});
