import { describe, expect, it } from "vitest";

import { formatPlans, planPrice, recordMoneyPayment, type PlanRow } from "../src/plans";
import type { Env } from "../src/types";

/**
 * Тарифы и ручной журнал платежей. Платёжный провайдер не подключён:
 * проверяем, что /pay записывает платёж, продлевает срок от максимума
 * «сейчас/текущий срок» и сбрасывает KV-кэш подписки.
 */

interface Call {
  sql: string;
  params: unknown[];
}

function makeEnv(user: Record<string, unknown> | null, plans: PlanRow[] = []) {
  const calls: Call[] = [];
  const deleted: string[] = [];

  const db = {
    prepare(sql: string) {
      const state: Call = { sql, params: [] };
      const stmt = {
        bind(...params: unknown[]) {
          state.params = params;
          return stmt;
        },
        async first() {
          calls.push(state);
          if (sql.includes("FROM users")) return user;
          if (sql.includes("FROM plans")) {
            return plans.find((plan) => plan.code === state.params[0]) ?? null;
          }
          return null;
        },
        async all() {
          calls.push(state);
          return { results: [] };
        },
        async run() {
          calls.push(state);
          return { success: true };
        },
      };
      return stmt;
    },
  };

  const cache = {
    async get() {
      return null;
    },
    async put() {
      return undefined;
    },
    async delete(key: string) {
      deleted.push(key);
      return true;
    },
  };

  return { env: { DB: db, CACHE: cache } as unknown as Env, calls, deleted };
}

const plan = (over: Partial<PlanRow> = {}): PlanRow => ({
  id: 1,
  code: "month",
  title: "Месяц",
  days: 30,
  price_rub: 0,
  device_limit: 3,
  traffic_gb: 200,
  active: 1,
  sort: 20,
  note: "",
  ...over,
});

describe("карточка тарифов", () => {
  it("пустой список — честная подсказка, а не выдуманные цены", () => {
    const text = formatPlans([]);
    expect(text).toContain("ещё не заполнен");
    expect(text).not.toContain("₽");
  });

  it("цена 0 показывается как «по договорённости»", () => {
    expect(planPrice(0)).toBe("цена по договорённости");
    expect(planPrice(299)).toBe("299 ₽");
  });

  it("перечисляет срок, цену, устройства и экранирует HTML", () => {
    const text = formatPlans([
      plan({ code: "trial", title: "Пробный <7>", days: 7, device_limit: null, traffic_gb: null }),
      plan({ code: "year", title: "Год", days: 365, price_rub: 1990 }),
    ]);
    expect(text).toContain("Пробный &lt;7&gt;");
    expect(text).toContain("7 дн.");
    expect(text).toContain("365 дн.");
    expect(text).toContain("1990 ₽");
    expect(text).toContain("устройств: 3");
  });
});

describe("ручной платёж", () => {
  it("записывает платёж, продлевает доступ и чистит кэш подписки", async () => {
    const user = {
      id: 10,
      tg_id: "777",
      sub_token: "tok-777",
      status: "active",
      expires_at: "2026-11-01 00:00:00", // уже в прошлом — считаем от «сейчас»
    };
    const { env, calls, deleted } = makeEnv(user, [plan()]);

    const result = await recordMoneyPayment(env, {
      tgId: "777",
      amountRub: 299,
      days: 30,
      actor: "tg:5680608085",
      note: "перевод",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("299 ₽");
    expect(result.message).toContain("30 дн.");

    const insert = calls.find((call) => call.sql.includes("INSERT INTO payments"));
    expect(insert).toBeTruthy();
    expect(insert?.params.slice(0, 4)).toEqual([10, null, 299, 30]);

    const update = calls.find((call) => call.sql.includes("UPDATE users"));
    expect(update?.params[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const until = Date.parse(String(update?.params[0]).replace(" ", "T") + "Z");
    const days = (until - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    expect(deleted.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.sql.includes("INSERT INTO events"))).toBe(true);
  });

  it("дни берутся из тарифа, если не указаны явно", async () => {
    const { env, calls } = makeEnv(
      { id: 11, tg_id: "888", sub_token: "t", status: "pending", expires_at: null },
      [plan({ code: "year", days: 365 })],
    );

    const result = await recordMoneyPayment(env, {
      tgId: "888",
      amountRub: 0,
      planCode: "year",
    });

    expect(result.ok).toBe(true);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO payments"));
    expect(insert?.params[3]).toBe(365);
  });

  it("неизвестный пользователь и отрицательная сумма отклоняются без записи", async () => {
    const missing = makeEnv(null);
    const first = await recordMoneyPayment(missing.env, { tgId: "404", amountRub: 100 });
    expect(first.ok).toBe(false);
    expect(missing.calls.some((call) => call.sql.includes("INSERT INTO payments"))).toBe(false);

    const negative = makeEnv({ id: 1, tg_id: "1", sub_token: "t", expires_at: null });
    const second = await recordMoneyPayment(negative.env, { tgId: "1", amountRub: -5 });
    expect(second.ok).toBe(false);
    expect(negative.calls.some((call) => call.sql.includes("INSERT INTO payments"))).toBe(false);
  });

  it("платёж без дней фиксируется, но срок не меняется", async () => {
    const { env, calls, deleted } = makeEnv({
      id: 12,
      tg_id: "999",
      sub_token: "t",
      status: "active",
      expires_at: "2026-12-01 00:00:00",
    });

    const result = await recordMoneyPayment(env, { tgId: "999", amountRub: 50, days: 0 });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("срок не менялся");
    expect(calls.some((call) => call.sql.includes("UPDATE users"))).toBe(false);
    expect(deleted).toHaveLength(0);
  });
});
