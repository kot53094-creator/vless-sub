/** Названия серверов для подписки: тип + пул, без имён сервисов-источников. */

import type { ParsedKey } from "./parser";

export function protocolLabel(key: ParsedKey): string {
  switch (key.proto) {
    case "vless":
      if (key.security === "reality") return "VLESS Reality";
      if (key.security === "tls") return "VLESS TLS";
      return "VLESS";
    case "vmess":
      return "VMess";
    case "trojan":
      return "Trojan";
    case "ss":
      return "Shadowsocks";
    case "hysteria2":
      return "Hysteria2";
    default:
      return "Node";
  }
}

const COUNTRY_RU: Record<string, string> = {
  DE: "Германия",
  NL: "Нидерланды",
  FI: "Финляндия",
  FR: "Франция",
  US: "США",
  GB: "Великобритания",
  SE: "Швеция",
  PL: "Польша",
  CA: "Канада",
  SG: "Сингапур",
  JP: "Япония",
  TR: "Турция",
  RU: "Россия",
  LV: "Латвия",
  LT: "Литва",
  EE: "Эстония",
  CH: "Швейцария",
  AT: "Австрия",
  CZ: "Чехия",
  RO: "Румыния",
  IT: "Италия",
  ES: "Испания",
  HK: "Гонконг",
  KZ: "Казахстан",
  AE: "ОАЭ",
  IN: "Индия",
  BR: "Бразилия",
  AU: "Австралия",
};

/** 🇩🇪 из «DE». Пустая строка, если код неизвестен. */
export function flagOf(code: string | null | undefined): string {
  const value = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return "";
  return String.fromCodePoint(...[...value].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

/** «VLESS · Германия» или «VLESS · Германия · Франкфурт». */
export function serverLabel(
  poolName: string | null,
  key: ParsedKey,
  index: number,
  custom?: string,
  geo?: { country?: string | null; city?: string | null; code?: string | null },
): string {
  // Своим ключам оставляем человеческое имя: человек должен узнать свой сервер.
  const own = custom?.trim();
  if (own) return own.slice(0, 40);

  const protocol = protocolLabel(key);
  const code = (geo?.code ?? "").trim().toUpperCase();
  // Локатор отдаёт английские названия — переводим известные страны,
  // остальные показываем как есть, врать не будем.
  const country = COUNTRY_RU[code] ?? (geo?.country ?? "").trim();
  if (!country) return `${protocol} · Регион неизвестен`;

  return `${protocol} · ${country}`;
}

export { COUNTRY_RU };

export function maskLink(link: string, keep = 14): string {
  if (link.length <= keep * 2) return "•".repeat(Math.min(link.length, 24));
  return `${link.slice(0, keep)}…${link.slice(-4)}`;
}

export function maskToken(token: string): string {
  return token.length <= 10 ? "…" : `${token.slice(0, 6)}…${token.slice(-4)}`;
}
