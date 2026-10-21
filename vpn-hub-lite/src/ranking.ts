/**
 * Отбор и приоритет серверов для подписки.
 *
 * Задача: вверху должны быть узлы, которые реально пробивают DPI в России.
 *  • Reality — современная маскировка, работает там, где TLS-прокси уже режут;
 *  • обычный WS/TLS на своём домене — работает, но хуже;
 *  • CDN-заглушки (pages.dev, workers.dev, vercel, netlify) — почти всегда
 *    недоступны из РФ, их не отдаём вовсе;
 *  • без TLS — не отдаём никогда.
 */

const CDN_HOSTS = ["pages.dev", "workers.dev", "vercel.app", "netlify.app"];

export interface RankableServer {
  link: string;
  visibility?: string;
}

export function isModern(server: RankableServer): boolean {
  const link = server.link ?? "";
  if (!/security=(reality|tls)/i.test(link)) return false;
  if (CDN_HOSTS.some((host) => link.includes(host))) return false;
  return true;
}

/**
 * Меньше — выше в списке.
 * 0 — свои ключи, 1 — Reality, 2 — TLS на своём домене.
 */
export function serverRank(server: RankableServer): number {
  const link = server.link ?? "";
  if (server.visibility === "private") return 0;
  if (/security=reality/i.test(link)) return 1;
  return 2;
}

export function compareServers<T extends RankableServer & { latency_ms?: number | null; id: number }>(
  a: T,
  b: T,
): number {
  const byRank = serverRank(a) - serverRank(b);
  if (byRank !== 0) return byRank;

  const la = a.latency_ms ?? Number.MAX_SAFE_INTEGER;
  const lb = b.latency_ms ?? Number.MAX_SAFE_INTEGER;
  if (la !== lb) return la - lb;

  return a.id - b.id;
}
