import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(async () => null),
  many: vi.fn(async () => []),
  run: vi.fn(async () => ({ meta: { changes: 1 } })),
  logEvent: vi.fn(async () => undefined),
  batch: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => h);

import { enabledProviders, PROVIDER_LABELS, transferRequisites } from "../src/pay";
import type { Env } from "../src/types";

/**
 * Какие способы оплаты видит человек.
 *
 * Правило: кнопка появляется только тогда, когда по ней реально можно
 * заплатить. Способ без ключей или без реквизитов — это не «на будущее»,
 * а сломанная касса.
 */

const base = { BOT_TOKEN: "123:abc" } as unknown as Env;

describe("способы оплаты", () => {
  it("всегда есть звёзды, если есть бот", () => {
    expect(enabledProviders(base)).toEqual(["stars"]);
  });

  it("СБП появляется вместе с ЮKassa — те же ключи", () => {
    const env = { ...base, YOOKASSA_SHOP_ID: "shop", YOOKASSA_SECRET: "sec" } as unknown as Env;
    const list = enabledProviders(env);
    expect(list).toContain("yookassa");
    expect(list).toContain("sbp");
  });

  it("перевод включается только с реквизитами", () => {
    expect(enabledProviders(base)).not.toContain("transfer");
    const withCard = { ...base, PAY_CARD: "2200 0000 0000 0000" } as unknown as Env;
    expect(enabledProviders(withCard)).toContain("transfer");
  });

  it("явный список ограничивает набор", () => {
    const env = {
      ...base,
      YOOKASSA_SHOP_ID: "shop",
      YOOKASSA_SECRET: "sec",
      PAY_PROVIDERS: "stars,sbp",
    } as unknown as Env;
    expect(enabledProviders(env)).toEqual(["stars", "sbp"]);
  });

  it("нельзя включить способ без секретов", () => {
    const env = { ...base, PAY_PROVIDERS: "yookassa,transfer" } as unknown as Env;
    expect(enabledProviders(env)).toEqual([]);
  });

  it("у каждого способа есть понятная подпись", () => {
    for (const id of ["stars", "sbp", "transfer", "cryptopay", "yookassa"] as const) {
      expect(PROVIDER_LABELS[id].length).toBeGreaterThan(1);
    }
  });

  it("реквизиты берутся из окружения", () => {
    const env = {
      PAY_PHONE: "+7 900 000-00-00",
      PAY_CARD: "2200 0000 0000 0000",
      PAY_RECEIVER: "ИП Иванов",
    } as unknown as Env;
    const req = transferRequisites(env);
    expect(req.available).toBe(true);
    expect(req.receiver).toBe("ИП Иванов");
  });
});
