import { describe, expect, it } from "vitest";

import {
  amountMinor,
  discountPercent,
  formatRub,
  moneyString,
  orderTtlHours,
  starsForPlan,
} from "../src/pay/money";
import type { Env } from "../src/types";
import type { PayPlan } from "../src/pay/types";

/**
 * Денежная арифметика — единственное место, где ошибка стоит реальных денег.
 * Проверяем: пересчёт в звёзды (округление вверх, ручная цена важнее),
 * минимальные единицы и TTL заказа.
 */

function env(extra: Partial<Env> = {}): Env {
  return { STAR_RUB: "1.3", ...extra } as unknown as Env;
}

const month: PayPlan = { code: "month", title: "Месяц", days: 30, price_rub: 190 };
const year: PayPlan = { code: "year", title: "Год", days: 365, price_rub: 1490 };

describe("цена в звёздах", () => {
  it("округляет вверх, чтобы не продавать дешевле", () => {
    // 190 / 1.3 = 146.15 → 147
    expect(starsForPlan(month, env())).toBe(147);
  });

  it("ручная цена тарифа важнее курса", () => {
    expect(starsForPlan({ ...month, price_stars: 199 }, env())).toBe(199);
  });

  it("курс меняется через STAR_RUB", () => {
    expect(starsForPlan(month, env({ STAR_RUB: "2" }))).toBe(95);
  });

  it("мусор в курсе не ломает кассу", () => {
    expect(starsForPlan(month, env({ STAR_RUB: "abc" }))).toBe(147);
    expect(starsForPlan(month, env({ STAR_RUB: "0" }))).toBe(147);
  });

  it("бесплатный тариф не превращается в платный", () => {
    expect(starsForPlan({ ...month, price_rub: 0 }, env())).toBe(0);
  });
});

describe("минимальные единицы", () => {
  it("рубли — в копейках, звёзды — целыми", () => {
    expect(amountMinor(190, "RUB")).toBe(19000);
    expect(amountMinor(190, "XTR")).toBe(190);
  });

  it("сумма для API — строка с двумя знаками", () => {
    expect(moneyString(190)).toBe("190.00");
    expect(moneyString(1490)).toBe("1490.00");
  });

  it("подпись цены не показывает копейки у целых рублей", () => {
    expect(formatRub(190)).toBe("190 ₽");
    expect(formatRub(0)).toBe("бесплатно");
  });
});

describe("скидка на длинном тарифе", () => {
  it("считается относительно месячной цены", () => {
    // 365 дней = 12.17 месяцев → 1490 / 12.17 = 122.5 ₽ против 190 ₽ → 36%
    expect(discountPercent(year, [month, year])).toBe(36);
  });

  it("без месячного тарифа скидки нет", () => {
    expect(discountPercent(year, [year])).toBe(0);
  });
});

describe("срок жизни счёта", () => {
  it("по умолчанию сутки", () => {
    expect(orderTtlHours({} as Env)).toBe(24);
  });

  it("ограничен разумными рамками", () => {
    expect(orderTtlHours({ ORDER_TTL_HOURS: "0" } as unknown as Env)).toBe(24);
    expect(orderTtlHours({ ORDER_TTL_HOURS: "9999" } as unknown as Env)).toBe(336);
  });
});
