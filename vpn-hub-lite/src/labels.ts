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

/**
 * Пример: «Европа · VLESS Reality #2».
 * Имя пула — единственная «география», которую видит пользователь;
 * название источника (сервиса) не раскрывается никогда.
 */
export function serverLabel(poolName: string | null, key: ParsedKey, index: number): string {
  const place = poolName && poolName.trim() ? poolName.trim() : "Node";
  return `${place} · ${protocolLabel(key)} #${index}`;
}

export function maskLink(link: string, keep = 14): string {
  if (link.length <= keep * 2) return "•".repeat(Math.min(link.length, 24));
  return `${link.slice(0, keep)}…${link.slice(-4)}`;
}

export function maskToken(token: string): string {
  return token.length <= 10 ? "…" : `${token.slice(0, 6)}…${token.slice(-4)}`;
}
