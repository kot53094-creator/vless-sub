import { describe, expect, it } from "vitest";

import { isDeliverable } from "../src/sub";

/**
 * Главный тест приватности: paid_private и visibility=private
 * не должны попадать в пользовательские подписки ни при каких условиях.
 */
describe("приватность подписки", () => {
  it("отдаёт обычный живой сервер из shareable-источника", () => {
    expect(
      isDeliverable({ status: "alive", visibility: "shareable", source_kind: "public" }),
    ).toBe(true);
  });

  it("не отдаёт paid_private даже при visibility=shareable", () => {
    expect(
      isDeliverable({ status: "alive", visibility: "shareable", source_kind: "paid_private" }),
    ).toBe(false);
  });

  it("не отдаёт источник с visibility=private", () => {
    expect(
      isDeliverable({ status: "alive", visibility: "private", source_kind: "own_vps" }),
    ).toBe(false);
  });

  it("не отдаёт мёртвый сервер", () => {
    expect(isDeliverable({ status: "dead", visibility: "shareable", source_kind: "public" })).toBe(false);
  });

  it("отдаёт непроверенный сервер: у Cloudflare-нод TCP-проба не работает", () => {
    // Осознанное решение: «нет ответа» не равно «мёртвый». Иначе ноды за
    // Cloudflare (162.159.x, saas.sin.fan) навсегда выпадают из подписки.
    expect(
      isDeliverable({ status: "unknown", visibility: "shareable", source_kind: "public" }),
    ).toBe(true);
  });

  it("при отсутствии полей считает сервер небезопасным", () => {
    expect(isDeliverable({})).toBe(false);
    expect(isDeliverable({ status: "alive" })).toBe(false);
  });
});
