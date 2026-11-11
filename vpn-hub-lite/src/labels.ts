/** Названия серверов для подписки: тип + пул, без имён сервисов-источников. */

import { BRAND } from "./brand";
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
  BY: "Беларусь",
  CN: "Китай",
  UA: "Украина",
  GE: "Грузия",
  AM: "Армения",
  AZ: "Азербайджан",
  UZ: "Узбекистан",
  MD: "Молдова",
  RS: "Сербия",
  BG: "Болгария",
  HU: "Венгрия",
  SK: "Словакия",
  GR: "Греция",
  PT: "Португалия",
  NO: "Норвегия",
  DK: "Дания",
  IE: "Ирландия",
  BE: "Бельгия",
  IL: "Израиль",
  KR: "Южная Корея",
  TH: "Таиланд",
  VN: "Вьетнам",
  ID: "Индонезия",
  MY: "Малайзия",
  MX: "Мексика",
  AR: "Аргентина",
  ZA: "ЮАР",
  EG: "Египет",
  CY: "Кипр",
};

/** 🇩🇪 из «DE». Пустая строка, если код неизвестен. */
export function flagOf(code: string | null | undefined): string {
  const value = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return "";
  return String.fromCodePoint(...[...value].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

/** Строка отчёта о замене: «🇩🇪 Германия → 🇫🇮 Финляндия · 2 чел.». */
export function replacementLine(dead: string, targets: string[], users: number): string {
  const to = targets.length ? targets.join(", ") : "замены не нашлось";
  return `${dead} → ${to} · ${users} чел.`;
}

/**
 * «24 мс» из замера. Пустая строка, если замера нет.
 *
 * Задержка в имени узла — главный признак живой платной подписки: человек
 * видит, что сервер не просто существует, а отвечает. Ноль и мусорные
 * значения не показываем, иначе в списке будет «0 мс» у мёртвого узла.
 */
export function formatPing(ping?: number | null): string {
  const value = Number(ping ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  return `${Math.round(value)} мс`;
}

/**
 * Похоже ли имя на человеческое. Технические теги источников («tier1-3»,
 * «proxy», «A1_EU__») человеку ничего не говорят — их заменяем на адрес.
 */
export function humanRemark(value?: string | null): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  if (/[А-Яа-яЁё]/.test(text)) return true;
  if (/\s/.test(text)) return true;
  if (text.length > 24) return true;
  return false;
}

/** Транспорт из ссылки: ws, grpc, xhttp… По умолчанию — tcp. */
export function transportOf(key: ParsedKey): string {
  let type = "tcp";
  try {
    type = (new URL(key.uri).searchParams.get("type") ?? "tcp").toLowerCase();
  } catch {
    type = "tcp";
  }
  switch (type) {
    case "splithttp":
    case "xhttp":
      return "XHTTP";
    case "ws":
      return "WS";
    case "grpc":
      return "gRPC";
    case "h2":
    case "http":
      return "HTTP/2";
    case "httpupgrade":
      return "HTTPUpgrade";
    case "quic":
      return "QUIC";
    case "kcp":
      return "mKCP";
    default:
      return "TCP";
  }
}

/**
 * Подпись под названием, как в приложениях: «VLESS / XHTTP / REALITY».
 * Именно из этих трёх частей складывается совместимость узла.
 */
export function protocolChain(key: ParsedKey): string {
  const proto = key.proto === "hysteria2" ? "HY2" : key.proto.toUpperCase();
  const security =
    key.security === "reality" ? "REALITY" : key.security === "tls" ? "TLS" : "NONE";
  // Хвост «| JSON» из старых импортов здесь не нужен: в имени узла он
  // выглядит как мусор, а формат конфигурации клиент и так знает.
  return `${proto} / ${transportOf(key)} / ${security}`;
}

/**
 * «🇩🇪 Германия · VLESS / TCP / REALITY».
 *
 * Флаг — единственная «иконка», которую клиент рисует сам, поэтому страна
 * стоит первой: в Happ список читается сверху вниз по флагам. Пинг не пишем —
 * клиент показывает свой, а два разных числа в одной строке только путают.
 */
export function serverLabel(
  poolName: string | null,
  key: ParsedKey,
  index: number,
  custom?: string,
  geo?: { country?: string | null; city?: string | null; code?: string | null },
  host?: string | null,
  ping?: number | null,
  tag?: string | null,
): string {
  const code = (geo?.code ?? "").trim().toUpperCase();
  // Локатор отдаёт английские названия — переводим известные страны,
  // остальные показываем как есть, врать не будем.
  const country = COUNTRY_RU[code] ?? (geo?.country ?? "").trim();
  // Город в названии, как в платных подписках («Нидерланды Amsterdam»):
  // по нему человек выбирает ближайший узел, а не только страну.
  const city = (geo?.city ?? "").trim();
  const place = country && city && !country.toLowerCase().includes(city.toLowerCase())
    ? `${country} ${city}`
    : country;
  // В карточке платного сервиса рядом с названием стоит задержка, а не
  // полная цепочка «VLESS / TCP / REALITY»: она занимает полстроки и
  // обрезается в Happ, из-за чего список выглядит техническим дампом.
  // Транспорт остаётся в короткой форме (VLESS Reality, VLESS XHTTP).
  const chain = protocolLabel(key);
  const pingText = formatPing(ping);
  const meta = pingText ? `${pingText} · ${chain}` : chain;
  const flag = flagOf(code);

  // Тарифная метка («Премиум») идёт сразу за флагом: страна остаётся
  // первым символом, чтобы список в клиенте читался по флагам, а тариф
  // был виден без прокрутки вправо.
  const mark = tag?.trim();
  if (mark) {
    const head = flag ? `${flag} ${mark}` : mark;
    return place ? `${head} · ${place} · ${meta}` : `${head} · ${host ?? "сервер"} · ${meta}`;
  }

  // Своим ключам оставляем человеческое имя: человек должен узнать свой сервер.
  const own = custom?.trim();
  if (own && humanRemark(own)) return own.slice(0, 40);

  if (place) return `${flag ? `${flag} ` : ""}${place} · ${meta}`;

  // Гео ещё не определено — показываем адрес, это честнее «Регион неизвестен».
  if (host) return `${host} · ${meta}`;
  return `Регион неизвестен · ${meta}`;
}

export { COUNTRY_RU };

export function maskLink(link: string, keep = 14): string {
  if (link.length <= keep * 2) return "•".repeat(Math.min(link.length, 24));
  return `${link.slice(0, keep)}…${link.slice(-4)}`;
}

export function maskToken(token: string): string {
  return token.length <= 10 ? "…" : `${token.slice(0, 6)}…${token.slice(-4)}`;
}
