import { describe, expect, it } from "vitest";

import {
  buildSubscription,
  decodePayload,
  isSingleKey,
  parseSubscription,
  parseUri,
  parseUserinfo,
  withLabel,
} from "../src/parser";

const VLESS =
  "vless://11111111-1111-1111-1111-111111111111@203.0.113.10:443?encryption=none&security=reality&sni=www.microsoft.com&type=tcp#DE-1";
const TROJAN = "trojan://secret@example.com:8443?security=tls&sni=example.com#NL";
const HY2 = "hy2://pass@example.org:443?sni=example.org#FI";
const VMESS =
  "vmess://" +
  btoa(JSON.stringify({ v: "2", ps: "JP", add: "198.51.100.7", port: "443", id: "abc", tls: "tls" }));

describe("parseUri", () => {
  it("разбирает VLESS Reality", () => {
    const key = parseUri(VLESS)!;
    expect(key.proto).toBe("vless");
    expect(key.host).toBe("203.0.113.10");
    expect(key.port).toBe(443);
    expect(key.security).toBe("reality");
    expect(key.sni).toBe("www.microsoft.com");
  });

  it("разбирает trojan, hysteria2 и vmess", () => {
    expect(parseUri(TROJAN)?.port).toBe(8443);
    expect(parseUri(HY2)?.proto).toBe("hysteria2");
    expect(parseUri(VMESS)?.host).toBe("198.51.100.7");
  });

  it("не падает на мусоре", () => {
    expect(parseUri("http://example.com")).toBeNull();
    expect(parseUri("vless://")).toBeNull();
    expect(parseUri("не ссылка")).toBeNull();
  });
});

describe("parseSubscription", () => {
  it("читает base64-подписку и убирает дубли", () => {
    const body = btoa([VLESS, TROJAN, HY2, VMESS, VLESS].join("\n"));
    const keys = parseSubscription(body);
    expect(keys).toHaveLength(4);
  });

  it("читает plain-текст с комментариями", () => {
    const text = `# комментарий\n${VLESS}\n${TROJAN}\n`;
    expect(parseSubscription(text)).toHaveLength(2);
  });

  it("уважает лимит ключей", () => {
    const many = Array.from({ length: 10 }, (_, i) => VLESS.replace("203.0.113.10", `203.0.113.${i + 1}`));
    expect(parseSubscription(many.join("\n"), 3)).toHaveLength(3);
  });

  it("decodePayload возвращает ссылки", () => {
    expect(decodePayload(btoa(VLESS))).toEqual([VLESS]);
  });

  it("isSingleKey отличает ключ от подписки", () => {
    expect(isSingleKey(VLESS)).toBe(true);
    expect(isSingleKey("https://example.com/sub")).toBe(false);
  });
});

describe("userinfo и подпись ссылок", () => {
  it("разбирает заголовок", () => {
    const info = parseUserinfo("upload=1024; download=2048; total=10240; expire=1767225600");
    expect(info).toEqual({ upload: 1024, download: 2048, total: 10240, expire: 1767225600 });
  });

  it("пустой заголовок даёт null", () => {
    expect(parseUserinfo(null)).toEqual({ upload: null, download: null, total: null, expire: null });
    expect(parseUserinfo("total=abc")).toEqual({
      upload: null, download: null, total: null, expire: null,
    });
  });

  it("подпись не ломает ссылку с якорем", () => {
    const labelled = withLabel(VLESS, "Европа · VLESS Reality #1");
    expect(labelled.split("#")).toHaveLength(2);
    expect(decodeURIComponent(labelled.split("#")[1])).toBe("Европа · VLESS Reality #1");
  });

  it("buildSubscription собирает base64, который читается обратно", () => {
    const encoded = buildSubscription([VLESS, TROJAN]);
    expect(parseSubscription(encoded)).toHaveLength(2);
  });
});
