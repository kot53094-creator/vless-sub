import { describe, expect, it } from "vitest";

import { isStrictDefault, isWorkingServer } from "../src/sub";
import type { Env } from "../src/types";

const REALITY =
  "vless://11111111-2222-3333-4444-555555555555@a.example.invalid:443" +
  "?security=reality&pbk=PUBKEY&sni=a.example.invalid&sid=ab12&fp=chrome&type=tcp#A";

const WS_TLS =
  "vless://11111111-2222-3333-4444-555555555555@188.114.97.6:443" +
  "?security=tls&type=ws&sni=cdn.example.invalid&host=cdn.example.invalid&path=%2F&fp=chrome#B";

const CDN_STUB =
  "vless://11111111-2222-3333-4444-555555555555@something.workers.dev:443" +
  "?security=tls&type=ws&sni=something.workers.dev&path=%2F#C";

const nowUtc = () =>
  new Date().toISOString().replace("T", " ").slice(0, 19);

describe("строгая выдача", () => {
  it("отдаёт свежий проверенный REALITY", () => {
    expect(
      isWorkingServer({ link: REALITY, verified_latency_ms: 120, verified_at: nowUtc() }),
    ).toBe(true);
  });

  it("отдаёт свежий проверенный WS+TLS", () => {
    expect(
      isWorkingServer({ link: WS_TLS, verified_latency_ms: 480, verified_at: nowUtc() }),
    ).toBe(true);
  });

  it("не отдаёт непроверенный узел любого протокола", () => {
    expect(isWorkingServer({ link: REALITY, verified_latency_ms: null })).toBe(false);
    expect(isWorkingServer({ link: WS_TLS, verified_latency_ms: 0 })).toBe(false);
  });

  it("выбрасывает устаревшую проверку", () => {
    const old = "2026-10-20 10:00:00";
    expect(
      isWorkingServer({ link: REALITY, verified_latency_ms: 200, verified_at: old }),
    ).toBe(false);
  });

  it("не отдаёт CDN-заглушки и голый TCP", () => {
    expect(
      isWorkingServer({ link: CDN_STUB, verified_latency_ms: 300, verified_at: nowUtc() }),
    ).toBe(false);
    expect(
      isWorkingServer({
        link: "vless://u@h:443?type=tcp",
        verified_latency_ms: 300,
        verified_at: nowUtc(),
      }),
    ).toBe(false);
  });

  it("строгий режим включён по умолчанию", () => {
    expect(isStrictDefault({} as Env)).toBe(true);
    expect(isStrictDefault({ STRICT_WORKING: "1" } as Env)).toBe(true);
    expect(isStrictDefault({ STRICT_WORKING: "0" } as Env)).toBe(false);
  });
});
