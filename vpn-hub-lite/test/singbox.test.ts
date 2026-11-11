import { describe, expect, it } from "vitest";

import { buildSingBoxConfig } from "../src/singbox_json";

const REALITY =
  "vless://11111111-2222-3333-4444-555555555555@de.example.com:443" +
  "?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=ab12&flow=xtls-rprx-vision#DE";

const WS =
  "vless://11111111-2222-3333-4444-555555555555@fi.example.com:8443" +
  "?type=ws&security=tls&sni=fi.example.com&path=%2Fws&host=fi.example.com#FI";

describe("sing-box конфиг", () => {
  it("собирает селектор и urltest", () => {
    const cfg = JSON.parse(buildSingBoxConfig([REALITY, WS]));
    const selector = cfg.outbounds.find((o: any) => o.tag === "select");
    const auto = cfg.outbounds.find((o: any) => o.tag === "auto");
    expect(selector.type).toBe("selector");
    expect(selector.default).toBe("auto");
    expect(auto.type).toBe("urltest");
    expect(auto.outbounds).toEqual(["DE", "FI"]);
    expect(cfg.route.final).toBe("select");
  });

  it("переносит REALITY и WS", () => {
    const cfg = JSON.parse(buildSingBoxConfig([REALITY, WS]));
    const de = cfg.outbounds.find((o: any) => o.tag === "DE");
    const fi = cfg.outbounds.find((o: any) => o.tag === "FI");
    expect(de.tls.reality.public_key).toBe("PUBKEY");
    expect(de.tls.server_name).toBe("www.microsoft.com");
    expect(de.flow).toBe("xtls-rprx-vision");
    expect(fi.transport.type).toBe("ws");
    expect(fi.transport.path).toBe("/ws");
    expect(fi.tls.server_name).toBe("fi.example.com");
  });

  it("отбрасывает не-vless", () => {
    const cfg = JSON.parse(buildSingBoxConfig(["ss://x@y:1#z", REALITY]));
    const tags = cfg.outbounds.map((o: any) => o.tag);
    expect(tags).toEqual(["select", "auto", "DE", "direct"]);
  });
});
