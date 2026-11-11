import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAN_DAYS,
  DEFAULT_TRAFFIC_GB,
  planDefaults,
  premiumHeaders,
  subscriptionUserinfo,
} from "../src/premium";

const DAY = 86_400_000;

describe("тариф в карточке подписки", () => {
  it("подставляет объём и срок, когда в базе пусто", () => {
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);
    const info = subscriptionUserinfo(
      { traffic_gb: 0, expires_at: null },
      planDefaults({}),
      now,
    );
    expect(info).toContain(`total=${DEFAULT_TRAFFIC_GB * 1024 ** 3}`);
    expect(info).toContain(`expire=${Math.floor((now + DEFAULT_PLAN_DAYS * DAY) / 1000)}`);
    expect(info).toContain("download=0");
  });

  it("данные из базы важнее тарифа по умолчанию", () => {
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);
    const info = subscriptionUserinfo(
      { traffic_gb: 50, expires_at: "2026-12-01 00:00:00" },
      planDefaults({}),
      now,
    );
    expect(info).toContain(`total=${50 * 1024 ** 3}`);
    expect(info).toContain(`expire=${Math.floor(Date.UTC(2026, 11, 1) / 1000)}`);
  });

  it("PREMIUM_LOOK=0 возвращает честные нули", () => {
    const info = subscriptionUserinfo(
      { traffic_gb: 0, expires_at: null },
      planDefaults({ PREMIUM_LOOK: "0" }),
      0,
    );
    expect(info).toBe("upload=0; download=0; total=0; expire=0");
  });

  it("читает объём и срок из окружения", () => {
    const plan = planDefaults({ PREMIUM_TRAFFIC_GB: "1024", PREMIUM_PLAN_DAYS: "30" });
    expect(plan.trafficGb).toBe(1024);
    expect(plan.days).toBe(30);
    expect(plan.enabled).toBe(true);
  });

  it("игнорирует мусор в переменных окружения", () => {
    const plan = planDefaults({ PREMIUM_TRAFFIC_GB: "abc", PREMIUM_PLAN_DAYS: "-5" });
    expect(plan.trafficGb).toBe(DEFAULT_TRAFFIC_GB);
    expect(plan.days).toBe(DEFAULT_PLAN_DAYS);
  });
});

describe("заголовки профиля", () => {
  it("отдаёт имя, страницу сервиса и поддержку", () => {
    const headers = premiumHeaders({
      baseUrl: "https://hub.example.com/",
      botUsername: "@ApelsinkaBot",
      refreshHours: 1,
    });
    expect(headers["profile-title"]).toBe("⚡ APELSINKA PREMIUM");
    expect(headers["profile-web-page-url"]).toBe("https://hub.example.com/");
    expect(headers["support-url"]).toBe("https://t.me/ApelsinkaBot");
    expect(headers["profile-update-interval"]).toBe("1");
  });

  it("не рисует пустые кнопки", () => {
    const headers = premiumHeaders({ baseUrl: "", botUsername: "", refreshHours: 6 });
    expect(headers["profile-web-page-url"]).toBeUndefined();
    expect(headers["support-url"]).toBeUndefined();
    expect(headers["profile-update-interval"]).toBe("6");
  });

  it("не принимает неполный адрес страницы", () => {
    const headers = premiumHeaders({
      baseUrl: "hub.example.com",
      botUsername: "bot",
      refreshHours: 1,
    });
    expect(headers["profile-web-page-url"]).toBeUndefined();
  });
});
