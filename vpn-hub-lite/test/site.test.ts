import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(async () => null),
  many: vi.fn(async () => [] as unknown[]),
  run: vi.fn(async () => ({ meta: { changes: 1 } })),
  logEvent: vi.fn(async () => undefined),
  batch: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => h);

import { landingPage } from "../src/site";
import { legalIndex, ofertaPage, privacyPage, refundPage } from "../src/legal";
import { orderPage } from "../src/pay/page";
import type { Env } from "../src/types";
import type { OrderRow } from "../src/pay/types";

/**
 * Страницы платного контура.
 *
 * Проверяем не вёрстку, а два свойства, которые легко сломать: цены на сайте
 * берутся из базы (а не из воздуха) и в текстах нет формулировок, за которые
 * в России штрафуют с сентября 2025 года.
 */

const env = {
  PUBLIC_BASE_URL: "https://vpn.example",
  BOT_USERNAME: "test_bot",
  BOT_TOKEN: "123:abc",
  STAR_RUB: "1.3",
} as unknown as Env;

const planRow = {
  id: 1,
  code: "month",
  title: "Месяц",
  days: 30,
  price_rub: 190,
  device_limit: 3,
  traffic_gb: null,
  active: 1,
  sort: 20,
  note: "Все серверы",
  price_stars: null,
  badge: "",
  featured: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.many.mockResolvedValue([planRow]);
  h.one.mockResolvedValue(null);
});

async function html(response: Response): Promise<string> {
  return await response.text();
}

describe("сайт", () => {
  it("показывает цену из базы и цену в звёздах", async () => {
    const page = await html(await landingPage(env));
    expect(page).toContain("190 ₽");
    expect(page).toContain("147 ⭐");
    expect(page).toContain("/legal/oferta");
  });

  it("не обещает обход блокировок", async () => {
    const page = await html(await landingPage(env));
    expect(page.toLowerCase()).not.toContain("обход блокиров");
    expect(page.toLowerCase()).not.toContain("запрещённ");
  });

  it("без тарифов не выдумывает цены", async () => {
    h.many.mockResolvedValue([]);
    const page = await html(await landingPage(env));
    expect(page).toContain("Тарифы настраиваются");
    expect(page).not.toContain("190 ₽");
  });
});

describe("документы", () => {
  it("индекс ссылается на три документа", async () => {
    const page = await html(legalIndex(env));
    expect(page).toContain("/legal/oferta");
    expect(page).toContain("/legal/refund");
    expect(page).toContain("/legal/privacy");
  });

  it("оферта без реквизитов честно об этом пишет", async () => {
    const page = await html(ofertaPage(env));
    expect(page).toContain("Реквизиты не заполнены");
    expect(page).toContain("Публичная оферта");
  });

  it("оферта подставляет реквизиты из окружения", async () => {
    const page = await html(
      ofertaPage({ ...env, LEGAL_ENTITY: "ИП Иванов", LEGAL_EMAIL: "pay@example.com" } as Env),
    );
    expect(page).toContain("ИП Иванов");
    expect(page).toContain("pay@example.com");
    expect(page).not.toContain("Реквизиты не заполнены");
  });

  it("политика перечисляет, что не хранится", async () => {
    const page = await html(privacyPage(env));
    expect(page).toContain("не хранит историю посещённых сайтов");
  });

  it("правила возврата называют срок и команду поддержки", async () => {
    const page = await html(refundPage(env));
    expect(page).toContain("3 дня");
    expect(page).toContain("/paysupport");
  });
});

describe("страница заказа", () => {
  const order: OrderRow = {
    id: 1,
    public_id: "ord_page",
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
  };

  it("для ожидающего счёта показывает сумму и статус", async () => {
    const page = await html(orderPage(env, order));
    expect(page).toContain("Ждёт оплаты");
    expect(page).toContain("190 ₽");
    expect(page).toContain("ord_page");
  });

  it("для оплаченного заказа ведёт в кабинет", async () => {
    const page = await html(
      orderPage(env, { ...order, status: "paid", paid_at: "2026-11-12 10:05:00" }),
    );
    expect(page).toContain("Оплата получена");
    expect(page).toContain("https://t.me/test_bot");
  });

  it("не показывает кнопку оплаты для истёкшего счёта", async () => {
    const page = await html(orderPage(env, { ...order, status: "expired" }));
    expect(page).toContain("Счёт истёк");
    expect(page).not.toContain("/start?provider=");
  });
});
