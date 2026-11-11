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

export function compareServers<
  T extends RankableServer & {
    latency_ms?: number | null;
    priority?: number | null;
    stability?: number | null;
    verified_latency_ms?: number | null;
    id: number;
  },
>(a: T, b: T): number {
  // Главное правило: то, что реально прошло проверку через туннель, стоит
  // выше всего. Ручной приоритет и «свои» серверы не могут обогнать факт
  // работающего соединения — иначе сверху снова окажутся мёртвые узлы.
  const aWorks = (a.verified_latency_ms ?? 0) > 0 ? 1 : 0;
  const bWorks = (b.verified_latency_ms ?? 0) > 0 ? 1 : 0;
  if (aWorks !== bWorks) return bWorks - aWorks;

  // Внутри работающих первым идёт самый быстрый: в Happ список читают сверху.
  if (aWorks === 1 && bWorks === 1) {
    const la = a.verified_latency_ms ?? Number.MAX_SAFE_INTEGER;
    const lb = b.verified_latency_ms ?? Number.MAX_SAFE_INTEGER;
    if (la !== lb) return la - lb;
  }

  // Ручной приоритет из админки важнее автоматического ранжирования.
  const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
  if (byPriority !== 0) return byPriority;

  // Среди проверенных сначала самый быстрый по замеру туннеля. Раньше тип
  // протокола перебивал задержку, и медленный REALITY (3 с) стоял выше
  // CDN-узла (550 мс) только из-за протокола.
  const aVerified = a.verified_latency_ms ?? 0;
  const bVerified = b.verified_latency_ms ?? 0;
  if (aVerified > 0 && bVerified > 0 && aVerified !== bVerified) {
    return aVerified - bVerified;
  }

  // Тип сервера: свои ключи → Reality → обычный TLS.
  const byRank = serverRank(a) - serverRank(b);
  if (byRank !== 0) return byRank;

  // Внутри группы решает качество: стабильность из истории проверок.
  // Непроверенные (0) уходят вниз, как запасные.
  const byStability = (b.stability ?? 0) - (a.stability ?? 0);
  if (Math.abs(byStability) > 0.001) return byStability;

  const la = a.latency_ms ?? Number.MAX_SAFE_INTEGER;
  const lb = b.latency_ms ?? Number.MAX_SAFE_INTEGER;
  if (la !== lb) return la - lb;

  return a.id - b.id;
}

/**
 * Ротация хвоста списка по эпохам времени — «как в платных VPN».
 *
 * Сверху закреплены первые `pinned` узлов: это самые быстрые проверенные
 * серверы, их автовыбор клиента берёт всегда и предсказуемо. Остальная
 * часть списка перемешивается детерминированно по номеру эпохи (каждые
 * ROTATION минут): запасные узлы получают равномерную нагрузку, свежие
 * подмешиваются в видимый список, а один неудачный источник не держит
 * полсписка в одних и тех же позициях вечно.
 *
 * Перемешивание mulberry32: одинаковый epoch всегда даёт одинаковый порядок
 * — из нескольких нод воркера и после кэша подписка у всех клиентов
 * совпадает, а соседние эпохи дают разные порядки.
 */
export function rotateTail<T>(items: T[], epoch: number, pinned: number): T[] {
  if (items.length <= pinned + 1) return items;
  const head = items.slice(0, pinned);
  const tail = items.slice(pinned);
  let seed = (Math.trunc(epoch) * 2654435761) >>> 0;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  return [...head, ...tail];
}
