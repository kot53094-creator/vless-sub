import { describe, expect, it } from "vitest";
import { deviceFamily, deviceModel } from "../src/sub";

describe("модель устройства для авто-имени", () => {
  it("берёт модель из WebView-строки Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; SM-A256E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36";
    expect(deviceModel(ua)).toBe("Samsung SM-A256E");
    expect(deviceFamily(ua)).toBe("android");
  });

  it("понимает Pixel и Redmi", () => {
    expect(deviceModel("Mozilla/5.0 (Linux; Android 13; Pixel 8 Build/TQ3A)")).toBe("Google Pixel 8");
    expect(deviceModel("Mozilla/5.0 (Linux; Android 12; Redmi Note 8 Pro Build/RP1A)")).toBe(
      "Redmi Note 8 Pro",
    );
  });

  it("клиент без модели отдаёт только платформу", () => {
    expect(deviceModel("Happ/2.5 (Android 14)")).toBe("Android");
    expect(deviceFamily("Happ/2.5 (Android 14)")).toBe("android");
  });

  it("iPhone и Windows", () => {
    const ios =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    expect(deviceModel(ios)).toBe("iPhone");
    expect(deviceFamily(ios)).toBe("ios");
    expect(deviceModel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows PC");
    expect(deviceFamily("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
  });

  it("неизвестный клиент без модели", () => {
    expect(deviceModel("INCY/3.9.7")).toBe("");
    expect(deviceFamily("INCY/3.9.7")).toBe("");
  });
});
