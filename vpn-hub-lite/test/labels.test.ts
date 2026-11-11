import { describe, expect, it } from "vitest";

import { formatPing, humanRemark, serverLabel } from "../src/labels";
import type { ParsedKey } from "../src/parser";

const key = {
  proto: "vless",
  security: "reality",
  host: "de4.eclvps.com",
  port: 443,
  remark: "tier1-3",
} as unknown as ParsedKey;

describe("подписи серверов", () => {
  it("отличает человеческое имя от технического тега", () => {
    expect(humanRemark("Мой сервер")).toBe(true);
    expect(humanRemark("Frankfurt fast")).toBe(true);
    expect(humanRemark("tier1-3")).toBe(false);
    expect(humanRemark("proxy")).toBe(false);
    expect(humanRemark("")).toBe(false);
  });

  it("технический тег заменяется адресом, задержкой и протоколом", () => {
    const label = serverLabel(null, key, 1, "tier1-3", {}, "de4.eclvps.com", 441);
    expect(label).toBe("de4.eclvps.com · 441 мс · VLESS Reality");
  });

  it("при известной стране показывает страну и задержку", () => {
    const label = serverLabel(null, key, 1, "", { code: "DE" }, "de4.eclvps.com", 441);
    expect(label).toBe("🇩🇪 Германия · 441 мс · VLESS Reality");
  });

  it("без замера не выдумывает задержку", () => {
    const label = serverLabel(null, key, 1, "", { code: "DE" }, "de4.eclvps.com", null);
    expect(label).toBe("🇩🇪 Германия · VLESS Reality");
  });

  it("сохраняет осмысленное имя владельца", () => {
    const label = serverLabel(null, key, 1, "Мой рабочий", { code: "DE" }, null, 500);
    expect(label).toBe("Мой рабочий");
  });
});

describe("задержка в подписи", () => {
  it("округляет миллисекунды", () => {
    expect(formatPing(23.6)).toBe("24 мс");
    expect(formatPing(120)).toBe("120 мс");
  });

  it("не показывает ноль и мусор", () => {
    expect(formatPing(0)).toBe("");
    expect(formatPing(-5)).toBe("");
    expect(formatPing(null)).toBe("");
    expect(formatPing(Number.NaN)).toBe("");
  });
});
