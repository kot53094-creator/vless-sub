import { describe, expect, it } from "vitest";
import { deviceLabel } from "../src/sub";

describe("подпись устройства", () => {
  it("достаёт модель и версию Android из UA WebView", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; SM-A336E Build/TP1A.220624.014; wv) AppleWebKit/537.36";
    expect(deviceLabel(ua)).toBe("Samsung SM-A336E · Android 13");
  });

  it("пропускает локаль перед моделью", () => {
    const ua =
      "Mozilla/5.0 (Linux; U; Android 11; ru-ru; Redmi Note 8 Pro Build/RP1A.200720.011)";
    expect(deviceLabel(ua)).toBe("Redmi Note 8 Pro · Android 11");
  });

  it("без модели показывает платформу и версию", () => {
    expect(deviceLabel("Happ/2.5 (Android 14)")).toBe("Android 14 · Happ");
  });

  it("маска WebView не считается моделью", () => {
    expect(deviceLabel("Mozilla/5.0 (Android 10; K)")).toBe("Android 10 · Клиент");
  });

  it("iPhone и версия iOS", () => {
    expect(deviceLabel("Happ/2.5 (iPhone; iOS 18.1)")).toBe("iPhone · iOS 18.1");
  });

  it("Windows ПК с версией", () => {
    expect(deviceLabel("Happ/2.5 (Windows NT 10.0)")).toBe("Windows PC · 10 / 11");
  });

  it("Mac с версией", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac · macOS 10.15.7");
  });

  it("совсем незнакомый клиент", () => {
    expect(deviceLabel("curl/8.4.0")).toBe("Устройство · Клиент");
  });
});
