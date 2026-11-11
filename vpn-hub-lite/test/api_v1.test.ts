import { describe, expect, it } from "vitest";

import { isPublishable, openapi, toPublicServer } from "../src/api_v1";

const REALITY_LINK =
  "vless://11111111-2222-3333-4444-555555555555@secret.example.invalid:443" +
  "?security=reality&pbk=PUBKEY&sni=secret.example.invalid&sid=ab12&fp=chrome&type=tcp#Node";

const baseRow = {
  id: 7,
  remark: "Amsterdam",
  link: REALITY_LINK,
  host: "secret.example.invalid",
  port: 443,
  status: "alive",
  latency_ms: 42,
  last_check_at: "2026-10-20 10:00:00",
  verified_at: "2026-10-20 10:05:00",
  verified_latency_ms: 310,
  country_name: "Нидерланды",
  city: "Амстердам",
  country_code: "NL",
  enabled: 1,
  priority: 0,
  visibility: "shareable",
  source_kind: "public",
  pool_name: "Европа",
};

describe("публичный API", () => {
  it("публикует только shareable VLESS + REALITY", () => {
    expect(isPublishable(baseRow)).toBe(true);
    expect(isPublishable({ ...baseRow, visibility: "private" })).toBe(false);
    expect(isPublishable({ ...baseRow, source_kind: "paid_private" })).toBe(false);
    expect(isPublishable({ ...baseRow, status: "dead" })).toBe(false);
    expect(isPublishable({ ...baseRow, enabled: 0 })).toBe(false);
    expect(isPublishable({ ...baseRow, link: REALITY_LINK.replace("security=reality", "security=tls") })).toBe(false);
    expect(isPublishable({ ...baseRow, link: REALITY_LINK.replace("pbk=PUBKEY&", "") })).toBe(false);
  });

  it("не отдаёт ссылку, хост, порт и UUID", () => {
    const serialized = JSON.stringify(toPublicServer(baseRow));

    expect(serialized).not.toContain("vless://");
    expect(serialized).not.toContain("11111111-2222");
    expect(serialized).not.toContain("secret.example.invalid");
    expect(serialized).not.toContain("\"host\"");
    expect(serialized).not.toContain("PUBKEY");
  });

  it("оставляет только нужные поля", () => {
    const server = toPublicServer(baseRow);
    expect(Object.keys(server).sort()).toEqual(
      [
        "checked",
        "city",
        "country",
        "country_code",
        "id",
        "last_check_at",
        "latency_ms",
        "name",
        "pool",
        "port_latency_ms",
        "protocol",
        "reality",
        "status",
        "verified_at",
      ].sort(),
    );
    expect(server.protocol).toBe("vless");
    expect(server.reality).toBe(true);
    expect(server.checked).toBe(true);
    // Наружу уходит только задержка туннеля, портовая — отдельным полем.
    expect(server.latency_ms).toBe(310);
    expect(server.port_latency_ms).toBe(42);
  });

  it("подставляет имя, если remark пустой", () => {
    expect(toPublicServer({ ...baseRow, remark: "" }).name).toBe("Сервер #7");
  });

  it("OpenAPI описывает все рабочие эндпоинты", () => {
    const document = openapi("https://example.invalid");
    expect(document.openapi).toBe("3.1.0");
    const paths = Object.keys(document.paths as Record<string, unknown>);
    expect(paths).toContain("/api/v1/status");
    expect(paths).toContain("/api/v1/stats");
    expect(paths).toContain("/api/v1/sources");
    expect(paths).toContain("/api/v1/servers");
    expect((document.servers as Array<{ url: string }>)[0].url).toBe("https://example.invalid");
  });
});
