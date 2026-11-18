import { describe, expect, it } from "vitest";
import { isQuiet, localHour, parseQuiet, quietLabel } from "../src/quiet";

/** 2026-11-11T15:30:00Z = 23:30 по Иркутску (UTC+8). */
const NIGHT_UTC = Date.parse("2026-11-11T15:30:00Z");
/** 2026-11-11T04:00:00Z = 12:00 по Иркутску. */
const DAY_UTC = Date.parse("2026-11-11T04:00:00Z");

describe("parseQuiet", () => {
  it("по умолчанию 23–8 и UTC+8", () => {
    expect(parseQuiet()).toEqual({ startHour: 23, endHour: 8, utcOffset: 8 });
  });

  it("off и 0 отключают тишину", () => {
    expect(parseQuiet("off")).toBeNull();
    expect(parseQuiet("0")).toBeNull();
    expect(parseQuiet("")).toBeNull();
  });

  it("мусор не включает тишину случайно", () => {
    expect(parseQuiet("23")).toBeNull();
    expect(parseQuiet("25-3")).toBeNull();
    expect(parseQuiet("8-8")).toBeNull();
  });

  it("смещение вне диапазона откатывается к 8", () => {
    expect(parseQuiet("23-8", "99")?.utcOffset).toBe(8);
    expect(parseQuiet("1-6", "-3")?.utcOffset).toBe(-3);
  });
});

describe("localHour", () => {
  it("переводит UTC в местное время", () => {
    expect(localHour(NIGHT_UTC, 8)).toBe(23);
    expect(localHour(DAY_UTC, 8)).toBe(12);
  });
});

describe("isQuiet", () => {
  const window = parseQuiet("23-8", "8");

  it("ночью тихо, днём нет", () => {
    expect(isQuiet(NIGHT_UTC, window)).toBe(true);
    expect(isQuiet(DAY_UTC, window)).toBe(false);
  });

  it("окно через полночь работает", () => {
    const early = Date.parse("2026-11-11T20:00:00Z"); // 04:00 местного
    expect(isQuiet(early, window)).toBe(true);
  });

  it("граница окончания не считается тишиной", () => {
    const eight = Date.parse("2026-11-12T00:00:00Z"); // 08:00 местного
    expect(isQuiet(eight, window)).toBe(false);
  });

  it("обычное окно без перехода через полночь", () => {
    const day = parseQuiet("13-15", "8");
    const at14 = Date.parse("2026-11-11T06:00:00Z"); // 14:00 местного
    expect(isQuiet(at14, day)).toBe(true);
  });

  it("выключенное окно никогда не тихое", () => {
    expect(isQuiet(NIGHT_UTC, null)).toBe(false);
  });
});

describe("quietLabel", () => {
  it("показывает окно и смещение", () => {
    expect(quietLabel(parseQuiet("23-8", "8"))).toBe("23:00–08:00 (UTC+8)");
    expect(quietLabel(null)).toBe("выключены");
  });
});
