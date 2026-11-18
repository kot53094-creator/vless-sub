import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  one: vi.fn(async () => null),
  many: vi.fn(async () => []),
  run: vi.fn(async () => ({ meta: { changes: 1 } })),
  logEvent: vi.fn(async () => undefined),
  batch: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => db);

import { verifyCryptoWebhook } from "../src/pay/cryptopay";
import { verifyYooPayment } from "../src/pay/yookassa";
import type { Env } from "../src/types";

/**
 * Проверки уведомлений провайдеров.
 *
 * Это самая опасная часть платного контура: сюда может прийти кто угодно.
 * Crypto Pay подтверждается подписью по сырому телу, ЮKassa — перечитыванием
 * платежа через API со сверкой суммы.
 */

const env = {
  CRYPTOPAY_TOKEN: "12345:AAHtest",
  YOOKASSA_SHOP_ID: "shop",
  YOOKASSA_SECRET: "secret",
} as unknown as Env;

async function cryptoSignature(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(env.CRYPTOPAY_TOKEN));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Crypto Pay: подпись вебхука", () => {
  const body = JSON.stringify({
    update_type: "invoice_paid",
    payload: { invoice_id: 42, payload: "ord_abc", status: "paid" },
  });

  it("принимает верную подпись", async () => {
    expect(await verifyCryptoWebhook(env, body, await cryptoSignature(body))).toBe(true);
  });

  it("отклоняет поддельную подпись", async () => {
    expect(await verifyCryptoWebhook(env, body, "deadbeef")).toBe(false);
  });

  it("отклоняет подпись от другого тела", async () => {
    const other = body.replace("ord_abc", "ord_evil");
    expect(await verifyCryptoWebhook(env, other, await cryptoSignature(body))).toBe(false);
  });

  it("без токена проверка всегда отрицательная", async () => {
    expect(await verifyCryptoWebhook({} as Env, body, await cryptoSignature(body))).toBe(false);
  });
});

describe("ЮKassa: проверка платежа через API", () => {
  function stub(payment: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payment), { status: 200 })),
    );
  }

  it("успешный платёж с нужной суммой и заказом", async () => {
    stub({
      id: "pay_1",
      status: "succeeded",
      amount: { value: "190.00", currency: "RUB" },
      metadata: { order_public_id: "ord_abc" },
    });
    const result = await verifyYooPayment(env, "pay_1", 190, "ord_abc");
    expect(result.ok).toBe(true);
    expect(result.event?.amountMinor).toBe(19000);
  });

  it("отклоняет платёж с другой суммой", async () => {
    stub({
      id: "pay_1",
      status: "succeeded",
      amount: { value: "1.00", currency: "RUB" },
      metadata: { order_public_id: "ord_abc" },
    });
    const result = await verifyYooPayment(env, "pay_1", 190, "ord_abc");
    expect(result.ok).toBe(false);
  });

  it("отклоняет чужой заказ в metadata", async () => {
    stub({
      id: "pay_1",
      status: "succeeded",
      amount: { value: "190.00", currency: "RUB" },
      metadata: { order_public_id: "ord_other" },
    });
    const result = await verifyYooPayment(env, "pay_1", 190, "ord_abc");
    expect(result.ok).toBe(false);
  });

  it("отклоняет незавершённый платёж", async () => {
    stub({ id: "pay_1", status: "pending", amount: { value: "190.00", currency: "RUB" } });
    const result = await verifyYooPayment(env, "pay_1", 190, "ord_abc");
    expect(result.ok).toBe(false);
  });

  it("падение сети не считается оплатой", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const result = await verifyYooPayment(env, "pay_1", 190, "ord_abc");
    expect(result.ok).toBe(false);
  });
});
