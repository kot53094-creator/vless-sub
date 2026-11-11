import { describe, expect, it } from "vitest";

import { normalizeVlessLink } from "../src/normalize";

describe("починка ссылок", () => {
  it("разделяет склеенный path и fp", () => {
    const broken =
      "vless://uuid@188.114.97.6:443?security=tls&type=ws&path=/?TELEGRAM--X--Xfp=chrome&sni=s.example#3";
    const fixed = normalizeVlessLink(broken);
    expect(fixed).toContain("fp=chrome");
    expect(fixed).toMatch(/path=%2F%3FTELEGRAM--X--X(&|$)/);
  });

  it("раскодирует двойное кодирование пути", () => {
    const broken =
      "vless://uuid@1.2.3.4:443?security=tls&type=ws&path=%252F%253Fx&host=h.example#4";
    const fixed = normalizeVlessLink(broken);
    expect(fixed).toContain("path=%2F%3Fx");
    expect(fixed).not.toContain("%252F");
  });

  it("ставит скобки вокруг IPv6 без них", () => {
    const broken = "vless://uuid@2a06:98c1:3121::7:443?security=tls&type=ws#10";
    const fixed = normalizeVlessLink(broken);
    expect(fixed).toContain("@[2a06:98c1:3121::7]:443");
  });

  it("сохраняет корректную ссылку без искажений", () => {
    const good =
      "vless://uuid@a.example:443?security=reality&pbk=K&sni=a.example&sid=ab&fp=chrome&type=tcp#A";
    const fixed = normalizeVlessLink(good);
    expect(fixed).toContain("security=reality");
    expect(fixed).toContain("pbk=K");
    expect(fixed).toContain("fp=chrome");
  });

  it("заменяет недопустимый fingerprint и убирает дубли", () => {
    const broken =
      "vless://uuid@1.2.3.4:443?security=tls&type=ws&fp=unsafe&fp=chrome#8";
    const fixed = normalizeVlessLink(broken);
    expect(fixed).toContain("fp=chrome");
    expect(fixed.match(/fp=/g)?.length).toBe(1);
  });

  it("не трогает не-VLESS строки", () => {
    expect(normalizeVlessLink("ss://abc")).toBe("ss://abc");
  });
});
