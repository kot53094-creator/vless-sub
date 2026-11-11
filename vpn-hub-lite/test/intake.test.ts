import { describe, expect, it } from "vitest";

import { classifyReality, describeRejects, scanSubscription } from "../src/intake";

// Конфигурации вымышленные: домен example.invalid зарезервирован для тестов,
// ключи и UUID ничего не открывают.
const REALITY =
  "vless://11111111-2222-3333-4444-555555555555@a.example.invalid:443" +
  "?security=reality&pbk=PUBKEY_A&sni=a.example.invalid&sid=ab12&fp=chrome&type=tcp#A";

const REALITY_SECOND =
  "vless://11111111-2222-3333-4444-555555555555@b.example.invalid:8443" +
  "?security=reality&pbk=PUBKEY_B&sni=b.example.invalid&sid=cd34&fp=chrome&type=tcp#B";

const VLESS_TLS =
  "vless://11111111-2222-3333-4444-555555555555@c.example.invalid:443" +
  "?security=tls&sni=c.example.invalid&type=ws#C";

const TROJAN = "trojan://secret@d.example.invalid:443#D";

describe("разбор источника", () => {
  it("считает только VLESS + REALITY пригодными к публикации", () => {
    const result = scanSubscription([REALITY, REALITY_SECOND, VLESS_TLS, TROJAN].join("\n"));

    expect(result.keys).toHaveLength(4);
    expect(result.stats.lines).toBe(4);
    expect(result.stats.parsed).toBe(4);
    expect(result.stats.accepted).toBe(4);
    expect(result.stats.publishable).toBe(2);
    expect(result.stats.rejects.not_vless).toBe(1);
    expect(result.stats.rejects.security_not_reality).toBe(1);
  });

  it("объединяет повторы по протоколу, хосту и порту", () => {
    const duplicate = REALITY.replace("#A", "#A-копия");
    const result = scanSubscription([REALITY, duplicate, REALITY_SECOND].join("\n"));

    expect(result.keys).toHaveLength(2);
    expect(result.stats.rejects.duplicate).toBe(1);
    expect(result.stats.publishable).toBe(2);
  });

  it("не считает дубликатом тот же хост на другом порту", () => {
    const otherPort = REALITY.replace(":443?", ":8443?");
    const result = scanSubscription([REALITY, otherPort].join("\n"));

    expect(result.keys).toHaveLength(2);
    expect(result.stats.rejects.duplicate).toBeUndefined();
  });

  it("запоминает причину: нет pbk, нет sid, нет fp", () => {
    const noPbk = REALITY.replace("pbk=PUBKEY_A&", "");
    const noSid = REALITY.replace("&sid=ab12", "");
    const noFp = REALITY.replace("&fp=chrome", "");

    expect(classifyReality(noPbk)).toBe("no_pbk");
    expect(classifyReality(noSid)).toBe("no_sid");
    expect(classifyReality(noFp)).toBe("no_fp");
    expect(classifyReality(REALITY)).toBeNull();
  });

  it("отделяет нечитаемые строки от валидных", () => {
    const result = scanSubscription(["мусор", TROJAN, REALITY].join("\n"));

    expect(result.stats.lines).toBe(3);
    expect(result.stats.parsed).toBe(2);
    expect(result.stats.rejects.unparsable).toBe(1);
    expect(result.stats.rejects.not_vless).toBe(1);
    expect(result.stats.publishable).toBe(1);
  });

  it("понимает base64-подписку", () => {
    const raw = [REALITY, REALITY_SECOND].join("\n");
    const encoded = btoa(raw);
    const result = scanSubscription(encoded);

    expect(result.keys).toHaveLength(2);
    expect(result.stats.publishable).toBe(2);
  });

  it("не выходит за лимит прогона и помечает остаток", () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      REALITY.replace("a.example.invalid", `a${index}.example.invalid`).replace("#A", `#${index}`),
    ).join("\n");

    const result = scanSubscription(many, 2);
    expect(result.keys).toHaveLength(2);
    expect(result.stats.rejects.limit).toBe(3);
  });

  it("на пустом теле не падает", () => {
    const result = scanSubscription("");
    expect(result.keys).toHaveLength(0);
    expect(result.stats.publishable).toBe(0);
  });

  it("пишет причины по-русски и по убыванию", () => {
    const text = describeRejects({ no_pbk: 2, not_vless: 5 });
    expect(text).toBe("не VLESS 5 · нет pbk 2");
  });
});
