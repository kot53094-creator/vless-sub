import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(),
  many: vi.fn(async () => []),
  run: vi.fn(),
  logEvent: vi.fn(async () => undefined),
  batch: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => h);

const accrual = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    duplicate: false,
    hours: 720,
    expiresAt: "2026-12-12 00:00:00",
  })),
);
vi.mock("../src/bonus", () => ({ applyAccrual: accrual }));

const recordsPayment = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/payments", () => ({ recordsPayment }));

import {
  closeOrder,
  createOrder,
  markOrderPaid,
  markOrderRefunded,
  type PaidResult,
} from "../src/orders";
import type { Env, UserRow } from "../src/types";
import type { OrderRow, PayPlan } from "../src/pay/types";

/**
 * Жизненный цикл заказа.
 *
 * Главное, что проверяется: деньги списываются один раз и дни начисляются
 * один раз — даже если Telegram или провайдер доставят уведомление повторно.
 */

const env = {
  STAR_RUB: "1.3",
  PUBLIC_BASE_URL: "https://vpn.example",
  ORDER_TTL_HOURS: "24",
} as unknown as Env;

const plan: PayPlan = {
  code: "month",
  title: "Месяц",
  days: 30,
  price_rub: 190,
  device_limit: 3,
};

function makeOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 1,
    public_id: "ord_test123",
    user_id: 42,
    plan_code: "month",
    plan_title: "Месяц",
    days: 30,
    device_limit: 3,
    traffic_gb: null,
    amount_rub: 190,
    amount_minor: 19000,
    currency: "RUB",
    provider: "yookassa",
    status: "pending",
    external_id: null,
    telegram_charge_id: null,
    provider_charge_id: null,
    promo_code: "",
    note: "",
    created_at: "2026-11-12 10:00:00",
    updated_at: "2026-11-12 10:00:00",
    paid_at: null,
    refunded_at: null,
    ...overrides,
  };
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 42,
    tg_id: "700000001",
    tg_username: "buyer",
    status: "expired",
    created_at: "2026-10-01 00:00:00",
    expires_at: "2026-11-01 00:00:00",
    device_limit: 2,
    sub_token: "tok",
    last_fetch_at: null,
    note: "",
    ...overrides,
  } as UserRow;
}

interface State {
  order: OrderRow | null;
  user: UserRow;
}

/** Мини-имитация SQL: ровно те запросы, которые делает orders.ts. */
function wire(state: State) {
  h.one.mockImplementation(async (_env: unknown, sql: string, ...params: unknown[]) => {
    if (sql.includes("FROM orders")) {
      if (!state.order) return null;
      if (sql.includes("public_id")) {
        return params[0] === state.order.public_id ? state.order : null;
      }
      return state.order;
    }
    if (sql.includes("FROM users")) return state.user;
    return null;
  });

  h.run.mockImplementation(async (_env: unknown, sql: string, ...params: unknown[]) => {
    if (sql.includes("INSERT INTO orders")) {
      // Порядок параметров совпадает с INSERT в createOrder.
      state.order = makeOrder({
        public_id: String(params[0]),
        plan_code: String(params[2]),
        plan_title: String(params[3]),
        days: Number(params[4]),
        device_limit: (params[5] as number | null) ?? null,
        amount_rub: Number(params[7]),
        amount_minor: Number(params[8]),
        currency: String(params[9]),
        provider: params[10] as OrderRow["provider"],
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE orders SET status = 'refunded'")) {
      if (state.order?.status === "paid") {
        state.order.status = "refunded";
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE orders") && sql.includes("SET status = 'paid'")) {
      if (state.order?.status === "pending") {
        state.order.status = "paid";
        state.order.external_id = String(params[0] ?? "");
        state.order.telegram_charge_id = (params[1] as string | null) ?? null;
        state.order.paid_at = "2026-11-12 10:05:00";
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE orders SET status = ?")) {
      if (state.order?.status === "pending") {
        state.order.status = params[0] as OrderRow["status"];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    return { meta: { changes: 1 } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accrual.mockResolvedValue({
    ok: true,
    duplicate: false,
    hours: 720,
    expiresAt: "2026-12-12 00:00:00",
  });
});

describe("создание заказа", () => {
  it("фиксирует цену, сроки и цену в звёздах", async () => {
    const state: State = { order: makeOrder(), user: makeUser() };
    wire(state);

    const result = await createOrder(env, state.user, plan, "stars");
    expect(result.ok).toBe(true);
    // Для звёзд amount_minor — это сами звёзды: 190 / 1.3 → 147.
    expect(result.order?.amount_minor).toBe(147);
    expect(result.order?.currency).toBe("XTR");
  });

  it("не продаёт бесплатный тариф", async () => {
    const state: State = { order: null, user: makeUser() };
    wire(state);
    const result = await createOrder(env, state.user, { ...plan, price_rub: 0 }, "yookassa");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("нельзя купить");
  });
});

describe("оплата", () => {
  it("переводит заказ в paid и начисляет дни", async () => {
    const state: State = { order: makeOrder(), user: makeUser() };
    wire(state);

    const result: PaidResult = await markOrderPaid(env, "ord_test123", {
      externalId: "pay_1",
      currency: "RUB",
      amountMinor: 19000,
    });

    expect(result.ok).toBe(true);
    expect(result.already).toBe(false);
    expect(state.order?.status).toBe("paid");
    expect(accrual).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ userId: 42, kind: "payment", days: 30, ref: "order:ord_test123" }),
    );
    expect(recordsPayment).toHaveBeenCalledTimes(1);
  });

  it("повторное уведомление не начисляет дни второй раз", async () => {
    const state: State = { order: makeOrder(), user: makeUser() };
    wire(state);

    await markOrderPaid(env, "ord_test123", {
      externalId: "pay_1",
      currency: "RUB",
      amountMinor: 19000,
    });
    const second = await markOrderPaid(env, "ord_test123", {
      externalId: "pay_1",
      currency: "RUB",
      amountMinor: 19000,
    });

    expect(second.already).toBe(true);
    expect(accrual).toHaveBeenCalledTimes(1);
    expect(recordsPayment).toHaveBeenCalledTimes(1);
  });

  it("не выдаёт доступ по отменённому заказу", async () => {
    const state: State = { order: makeOrder({ status: "canceled" }), user: makeUser() };
    wire(state);

    const result = await markOrderPaid(env, "ord_test123", {
      externalId: "pay_1",
      currency: "RUB",
      amountMinor: 19000,
    });

    expect(result.already).toBe(true);
    expect(accrual).not.toHaveBeenCalled();
    expect(state.order?.status).toBe("canceled");
  });

  it("неизвестный заказ не превращается в оплату", async () => {
    const state: State = { order: null, user: makeUser() };
    wire(state);
    const result = await markOrderPaid(env, "ord_missing", {
      externalId: "pay_1",
      currency: "RUB",
      amountMinor: 19000,
    });
    expect(result.ok).toBe(false);
    expect(accrual).not.toHaveBeenCalled();
  });
});

describe("возврат", () => {
  it("снимает дни, но не уводит срок в прошлое", async () => {
    const state: State = {
      order: makeOrder({ status: "paid", paid_at: "2026-11-12 10:05:00" }),
      // Осталось 20 дней, возвращаем 30 — срок должен стать «сейчас».
      user: makeUser({ expires_at: "2026-12-02 00:00:00" }),
    };
    wire(state);

    const result = await markOrderRefunded(env, "ord_test123", { deductDays: true });
    expect(result.ok).toBe(true);
    expect(result.daysRemoved).toBe(30);

    const update = h.run.mock.calls.find(
      (call) => String(call[1]).includes("UPDATE users SET expires_at"),
    );
    expect(update).toBeDefined();
    const until = new Date(String(update?.[2]).replace(" ", "T") + "Z").getTime();
    expect(until).toBeGreaterThanOrEqual(Date.now() - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("повторный возврат ничего не снимает", async () => {
    const state: State = { order: makeOrder({ status: "refunded" }), user: makeUser() };
    wire(state);
    const result = await markOrderRefunded(env, "ord_test123", {});
    expect(result.already).toBe(true);
    expect(result.daysRemoved).toBe(0);
  });

  it("неоплаченный заказ вернуть нельзя", async () => {
    const state: State = { order: makeOrder(), user: makeUser() };
    wire(state);
    const result = await markOrderRefunded(env, "ord_test123", {});
    expect(result.ok).toBe(false);
  });
});

describe("закрытие заказа", () => {
  it("отменяет только ожидающий счёт", async () => {
    const state: State = { order: makeOrder(), user: makeUser() };
    wire(state);
    expect(await closeOrder(env, "ord_test123", "canceled", "передумал")).toBe(true);
    expect(state.order?.status).toBe("canceled");
    expect(await closeOrder(env, "ord_test123", "expired")).toBe(false);
  });
});
