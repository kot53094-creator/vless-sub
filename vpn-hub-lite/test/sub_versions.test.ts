import { describe, expect, it } from "vitest";

import { fingerprintOf, parseIds, stableIds } from "../src/sub_versions";

describe("версии подписки", () => {
  it("приводит состав к стабильному порядку", () => {
    expect(stableIds([5, 1, 3])).toEqual([1, 3, 5]);
    expect(stableIds([3, 3, 3])).toEqual([3]);
  });

  it("не меняет отпечаток при другом порядке", () => {
    expect(fingerprintOf([9, 2, 5])).toBe(fingerprintOf([5, 9, 2]));
  });

  it("меняет отпечаток при изменении состава", () => {
    expect(fingerprintOf([1, 2, 3])).not.toBe(fingerprintOf([1, 2, 4]));
    expect(fingerprintOf([1, 2, 3])).not.toBe(fingerprintOf([1, 2, 3, 4]));
  });

  it("отбрасывает мусор и неположительные id", () => {
    expect(stableIds([0, -4, 2.7, 8])).toEqual([8]);
    expect(stableIds([Number.NaN, 4])).toEqual([4]);
  });

  it("разбирает сохранённый список id", () => {
    expect(parseIds("4, 2,4,abc,0,-1")).toEqual([2, 4]);
    expect(parseIds("")).toEqual([]);
  });
});
