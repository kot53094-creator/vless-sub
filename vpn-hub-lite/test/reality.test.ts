import { describe, expect, it } from "vitest";

import { checkReality, rejectReason } from "../src/reality";

// Тестовые конфигурации: адреса и ключи вымышленные, к реальным узлам
// отношения не имеют.
const VALID =
  "vless://11111111-2222-3333-4444-555555555555@example.invalid:443" +
  "?security=reality&pbk=PUBLICKEY_TEST&sni=example.invalid&sid=ab12&fp=chrome&type=tcp#test";

describe("VLESS + REALITY", () => {
  it("принимает полный набор параметров", () => {
    const result = checkReality(VALID);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.params?.pbk).toBe("PUBLICKEY_TEST");
    expect(result.params?.sid).toBe("ab12");
  });

  it("понимает альтернативные имена полей", () => {
    const alt =
      "vless://11111111-2222-3333-4444-555555555555@example.invalid:443" +
      "?security=reality&publicKey=K&serverName=example.invalid&shortId=cd34&fingerprint=firefox&type=grpc";
    const result = checkReality(alt);
    expect(result.ok).toBe(true);
    expect(result.params?.sni).toBe("example.invalid");
    expect(result.params?.type).toBe("grpc");
  });

  it("отбрасывает VLESS без REALITY", () => {
    const tls = VALID.replace("security=reality", "security=tls");
    expect(checkReality(tls).ok).toBe(false);
    expect(rejectReason(tls)).toContain("reality");
  });

  it("требует pbk, sni, sid и fp", () => {
    const noPbk = VALID.replace("pbk=PUBLICKEY_TEST&", "");
    const noSid = VALID.replace("&sid=ab12", "");
    const noFp = VALID.replace("&fp=chrome", "");

    expect(checkReality(noPbk).errors).toContain("нет pbk");
    expect(checkReality(noSid).errors).toContain("нет sid");
    expect(checkReality(noFp).errors).toContain("нет fp");
  });

  it("не считает REALITY другие протоколы", () => {
    expect(checkReality("vmess://eyJhZGQiOiJleGFtcGxlLmludmFsaWQifQ==").ok).toBe(false);
    expect(checkReality("trojan://pass@example.invalid:443").ok).toBe(false);
    expect(checkReality("ss://YWVzLTI1Ni1nY206cGFzcw==@example.invalid:443").ok).toBe(false);
  });

  it("не падает на мусоре", () => {
    expect(checkReality("vless://").ok).toBe(false);
    expect(checkReality("").ok).toBe(false);
    expect(checkReality("not a url at all").ok).toBe(false);
  });
});
