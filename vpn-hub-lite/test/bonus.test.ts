import { describe, expect, it } from "vitest";

import {
  clampToCap,
  extendExpiry,
  humanDuration,
  mskDate,
  mskMonth,
  nextStreak,
  normalizePromo,
  parsePromoCommand,
  parseRefCode,
  parseTs,
  plural,
  randomPromoCode,
  refCode,
  shiftDate,
  streakHours,
} from "../src/promotions";

describe("сутки по Москве", () => {
  it("23:59 UTC — это уже следующие сутки по Москве", () => {
    // 2026-10-21T20:59Z = 23:59 MSK
    expect(mskDate(Date.parse("2026-10-21T20:59:00Z"))).toBe("2026-10-21");
    // 2026-10-21T21:01Z = 00:01 MSK уже 22-го
    expect(mskDate(Date.parse("2026-10-21T21:01:00Z"))).toBe("2026-10-22");
  });

  it("месяц берётся по Москве, а не по UTC", () => {
    expect(mskMonth(Date.parse("2026-10-31T21:30:00Z"))).toBe("2026-11");
  });

  it("сдвиг даты не ломается на границе месяца", () => {
    expect(shiftDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("серия бонусов", () => {
  it("первый сбор — серия 1", () => {
    expect(nextStreak(null, 0, "2026-10-21")).toBe(1);
  });

  it("вчерашний сбор продолжает серию", () => {
    expect(nextStreak("2026-10-20", 4, "2026-10-21")).toBe(5);
  });

  it("пропуск дня сбрасывает серию", () => {
    expect(nextStreak("2026-10-18", 9, "2026-10-21")).toBe(1);
  });

  it("повторный сбор в тот же день не увеличивает серию", () => {
    expect(nextStreak("2026-10-21", 3, "2026-10-21")).toBe(3);
  });

  it("3-й и 7-й день дают повышенный бонус", () => {
    expect(streakHours(1, 1, 2, 3)).toBe(1);
    expect(streakHours(3, 1, 2, 3)).toBe(2);
    // каждый 3-й день (6, 9, 12…) — повышенный, каждый 7-й — самый большой
    expect(streakHours(6, 1, 2, 3)).toBe(2);
    expect(streakHours(7, 1, 2, 3)).toBe(3);
    expect(streakHours(14, 1, 2, 3)).toBe(3);
  });
});

describe("месячный потолок", () => {
  it("не выдаёт больше остатка", () => {
    expect(clampToCap(47, 48, 3)).toBe(1);
  });

  it("при выбранном потолке ничего не начисляет", () => {
    expect(clampToCap(48, 48, 1)).toBe(0);
    expect(clampToCap(60, 48, 1)).toBe(0);
  });

  it("обычный случай — выдаёт сколько просят", () => {
    expect(clampToCap(10, 48, 2)).toBe(2);
  });

  it("дробные часы не накапливают ошибку", () => {
    expect(clampToCap(47.5, 48, 1)).toBe(0.5);
  });
});

describe("реферальные коды", () => {
  it("код и обратное преобразование совпадают", () => {
    for (const id of [1, 7, 42, 5680608085]) {
      expect(parseRefCode(refCode(id))).toBe(id);
    }
  });

  it("мусор не превращается в id", () => {
    expect(parseRefCode("")).toBeNull();
    expect(parseRefCode("привет")).toBeNull();
    expect(parseRefCode("-5")).toBeNull();
  });
});

describe("промокоды", () => {
  it("нормализует регистр и пробелы", () => {
    expect(normalizePromo("  orange2026 ")).toBe("ORANGE2026");
    expect(normalizePromo("or-ange_1")).toBe("OR-ANGE_1");
  });

  it("вытаскивает код из команды", () => {
    expect(parsePromoCommand("/promo ABC123")).toBe("ABC123");
    expect(parsePromoCommand("/promo@apelsin_bot abc")).toBe("ABC");
    expect(parsePromoCommand("/promo")).toBeNull();
  });

  it("генератор даёт 8 символов без похожих букв", () => {
    const code = randomPromoCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});

describe("продление срока", () => {
  it("добавляет часы к будущему сроку", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const next = extendExpiry("2026-10-21 20:00:00", 2, now);
    expect(next).toBe("2026-10-21 22:00:00");
  });

  it("если срок истёк — считает от текущего момента", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const next = extendExpiry("2026-01-01 00:00:00", 1, now);
    expect(next).toBe("2026-10-21 13:00:00");
  });

  it("пустой срок — тоже от текущего момента", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(extendExpiry(null, 24, now)).toBe("2026-10-22 12:00:00");
  });

  it("разбирает формат D1", () => {
    expect(parseTs("2026-10-21 12:00:00")).toBe(Date.parse("2026-10-21T12:00:00Z"));
    expect(parseTs(null)).toBeNull();
    expect(parseTs("не дата")).toBeNull();
  });
});

describe("человеческие формулировки", () => {
  it("часы и минуты", () => {
    expect(humanDuration(1)).toBe("1 ч");
    expect(humanDuration(1.5)).toBe("1 ч 30 мин");
    expect(humanDuration(0.75)).toBe("45 мин");
    expect(humanDuration(48)).toBe("2 дня");
  });

  it("склонения", () => {
    expect(plural(1, "день", "дня", "дней")).toBe("день");
    expect(plural(3, "день", "дня", "дней")).toBe("дня");
    expect(plural(11, "день", "дня", "дней")).toBe("дней");
    expect(plural(21, "день", "дня", "дней")).toBe("день");
  });
});
