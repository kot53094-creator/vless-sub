import { describe, expect, it } from "vitest";
import { verifyTelegramInitData } from "../src/webapp_auth";

describe("verifyTelegramInitData", () => {
  const botToken = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz";

  it("отклоняет пустые данные", async () => {
    const res = await verifyTelegramInitData("", botToken);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_data");
  });

  it("отклоняет данные без hash", async () => {
    const res = await verifyTelegramInitData("auth_date=1700000000&user=%7B%22id%22%3A123%7D", botToken);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_hash");
  });

  it("отклоняет поддельный hash", async () => {
    // auth_date должен быть свежим: иначе проверка справедливо остановится
    // на «данные устарели» и до сравнения хэша дело не дойдёт.
    const authDate = Math.floor(Date.now() / 1000);
    const res = await verifyTelegramInitData(
      `auth_date=${authDate}&hash=0000000000000000000000000000000000000000000000000000000000000000&user=%7B%22id%22%3A123%7D`,
      botToken,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_hash");
  });

  it("отклоняет устаревшие данные до проверки хэша", async () => {
    const res = await verifyTelegramInitData(
      "auth_date=1700000000&hash=0000000000000000000000000000000000000000000000000000000000000000&user=%7B%22id%22%3A123%7D",
      botToken,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("initdata_expired");
  });

  it("проверяет корректно сформированный initData", async () => {
    const userJson = JSON.stringify({ id: 987654321, first_name: "Иван", username: "ivan_vpn" });
    const authDate = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      auth_date: String(authDate),
      query_id: "AAG_test_123",
      user: userJson,
    });

    // Строим data-check-string
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join("\n");

    const encoder = new TextEncoder();
    const webAppDataKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const secretKeyBytes = await crypto.subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken));

    const checkKey = await crypto.subtle.importKey(
      "raw",
      secretKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const hashBuffer = await crypto.subtle.sign("HMAC", checkKey, encoder.encode(dataCheckString));
    const calculatedHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    params.append("hash", calculatedHash);

    const verified = await verifyTelegramInitData(params.toString(), botToken);
    expect(verified.ok).toBe(true);
    expect(verified.user?.id).toBe(987654321);
    expect(verified.user?.first_name).toBe("Иван");
    expect(verified.user?.username).toBe("ivan_vpn");
  });
});
