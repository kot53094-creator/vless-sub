import { describe, expect, it } from "vitest";

import { buildAutoConfig, toOutbound } from "../src/xray_json";

const REALITY =
  "vless://11111111-2222-3333-4444-555555555555@de.example.com:443" +
  "?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=ab12&flow=xtls-rprx-vision#DE";

const WS =
  "vless://11111111-2222-3333-4444-555555555555@fi.example.com:8443" +
  "?type=ws&security=tls&sni=fi.example.com&path=%2Fws&host=fi.example.com#FI";

describe("outbound из ссылки", () => {
  it("переносит REALITY-параметры", () => {
    const out = toOutbound(REALITY, 0);
    expect(out?.tag).toBe("DE");
    expect(out?.settings.vnext[0].address).toBe("de.example.com");
    expect(out?.settings.vnext[0].users[0].flow).toBe("xtls-rprx-vision");
    const stream = out?.streamSettings as Record<string, any>;
    expect(stream.security).toBe("reality");
    expect(stream.realitySettings.publicKey).toBe("PUBKEY");
    expect(stream.realitySettings.shortId).toBe("ab12");
    expect(stream.realitySettings.serverName).toBe("www.microsoft.com");
  });

  it("переносит WS+TLS", () => {
    const stream = toOutbound(WS, 1)?.streamSettings as Record<string, any>;
    expect(stream.network).toBe("ws");
    expect(stream.wsSettings.path).toBe("/ws");
    expect(stream.wsSettings.headers.Host).toBe("fi.example.com");
    expect(stream.tlsSettings.serverName).toBe("fi.example.com");
  });

  it("пропускает не-vless", () => {
    expect(toOutbound("ss://abc@host:443#x", 0)).toBeNull();
    expect(toOutbound("не ссылка", 0)).toBeNull();
  });
});

describe("конфиг автовыбора", () => {
  it("собирает outbound'ы и балансировщик leastPing", () => {
    const config = JSON.parse(buildAutoConfig([REALITY, WS, "ss://x@y:1#z"]));
    const tags = config.outbounds.map((o: any) => o.tag);
    expect(tags).toEqual(["DE", "FI", "direct", "block"]);
    expect(config.routing.balancers[0].strategy.type).toBe("leastPing");
    expect(config.routing.balancers[0].selector).toEqual(["DE", "FI"]);
    expect(config.observatory.subjectSelector).toEqual(["DE", "FI"]);
  });

  it("не превышает лимит узлов", () => {
    const links = Array.from({ length: 40 }, (_, i) => REALITY.replace("de.example.com", `d${i}.example.com`));
    const config = JSON.parse(buildAutoConfig(links, 5));
    expect(config.outbounds).toHaveLength(7);
  });
});
