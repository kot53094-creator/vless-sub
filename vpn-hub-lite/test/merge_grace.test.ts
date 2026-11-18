import { describe, expect, it } from "vitest";
import { retainMissing } from "../src/merge";

const HOUR = 3600_000;
const now = Date.parse("2026-11-11T12:00:00Z");

function node(id: string, lastSeenAt: string | null) {
  return { id, lastSeenAt, addedAt: lastSeenAt ?? undefined };
}

describe("retainMissing", () => {
  it("узлы из нового ответа не считаются исчезнувшими", () => {
    const result = retainMissing(
      [node("a", "2026-11-11T11:00:00Z")],
      new Set(["a"]),
      now,
      HOUR * 24,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.removed).toBe(0);
  });

  it("исчезнувший узел держится внутри безопасного периода", () => {
    const result = retainMissing(
      [node("b", "2026-11-11T00:00:00Z")],
      new Set(),
      now,
      HOUR * 24,
    );
    expect(result.kept.map((item) => item.id)).toEqual(["b"]);
    expect(result.removed).toBe(0);
  });

  it("после истечения срока узел удаляется", () => {
    const result = retainMissing(
      [node("c", "2026-11-09T12:00:00Z")],
      new Set(),
      now,
      HOUR * 24,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.removed).toBe(1);
  });

  it("узел без времени последнего появления не держится вечно", () => {
    const result = retainMissing([node("d", null)], new Set(), now, HOUR * 24);
    expect(result.kept).toHaveLength(0);
    expect(result.removed).toBe(1);
  });

  it("нулевой льготный период удаляет сразу", () => {
    const result = retainMissing(
      [node("e", "2026-11-11T11:59:00Z")],
      new Set(),
      now,
      0,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.removed).toBe(1);
  });
});
