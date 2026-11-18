/**
 * Группы серверов «Апельсинка VPN»: AUTO / EUROPE / RUSSIA / BACKUP / ALL.
 *
 * Зачем отдельный модуль: группа — это не украшение списка, а правило отбора.
 * Клиент не умеет «переключать режим» по команде подписки, поэтому каждая
 * группа отдаётся либо отдельной ссылкой (base64-список), либо отдельным
 * профилем внутри JSON-подписки с собственным балансировщиком. Никаких
 * фиктивных переключателей: если группа пуста, её просто нет.
 *
 * Страна берётся из гео-справочника (`merge.ts`), а не из названия узла:
 * тег «Германия» у источника может стоять на нидерландском адресе.
 */

export type GroupKey = "auto" | "europe" | "russia" | "backup" | "all";

export const GROUP_ORDER: GroupKey[] = ["auto", "europe", "russia", "backup", "all"];

/** Подписи профилей. Короткие: в INCY имя подписки ограничено 25 символами. */
export const GROUP_TITLES: Record<GroupKey, string> = {
  auto: "AUTO · Апельсинка",
  europe: "EUROPE · Апельсинка",
  russia: "RUSSIA · Апельсинка",
  backup: "BACKUP · Апельсинка",
  all: "ALL · Апельсинка",
};

export const GROUP_DESCRIPTIONS: Record<GroupKey, string> = {
  auto: "Автоматический выбор: балансировщик leastPing переключает поток сам",
  europe: "Серверы Европы",
  russia: "Серверы России",
  backup: "Резерв: проверенные узлы вне основного отбора",
  all: "Все доступные серверы",
};

/**
 * Европа по ISO 3166-1 alpha-2. Россия вынесена отдельно, поэтому в этом
 * наборе её нет. Спорные гео (GE, AM, AZ, KZ, TR) сюда не включены: они
 * попадают только в AUTO/BACKUP/ALL — так честнее, чем записывать Казахстан
 * в Европу.
 */
const EUROPE_CC = new Set([
  "AD", "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK",
  "EE", "ES", "FI", "FO", "FR", "GB", "GG", "GI", "GR", "HR", "HU", "IE",
  "IM", "IS", "IT", "JE", "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MK",
  "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "UA",
  "VA", "XK",
]);

export type Region = "russia" | "europe" | "other";

export function regionOf(countryCode: string | null | undefined): Region {
  const cc = (countryCode ?? "").trim().toUpperCase();
  if (cc === "RU") return "russia";
  if (EUROPE_CC.has(cc)) return "europe";
  return "other";
}

/** Минимум полей, который нужен группировке. */
export interface GroupNode {
  id: string;
  link: string;
  countryCode: string;
  status: "alive" | "dead" | "unknown";
  latencyMs: number | null;
  /** Узел исчез из источника, но ещё держится в подписке (безопасный период). */
  missing?: boolean;
  /** Исключён администратором. */
  excluded?: boolean;
}

export interface PlanOptions {
  /** Сколько узлов класть в AUTO. */
  autoTop?: number;
  /** Потолок на группу: клиенту не нужны сотни строк. */
  limit?: number;
}

const DEFAULT_AUTO_TOP = 12;
const DEFAULT_LIMIT = 40;

/** Живые выше мёртвых, быстрые выше медленных, непроверенные — в конце. */
function rank(a: GroupNode, b: GroupNode): number {
  const statusRank = (node: GroupNode) =>
    node.status === "alive" ? 0 : node.status === "unknown" ? 1 : 2;
  return (
    statusRank(a) - statusRank(b) ||
    (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Разложить объединённый пул по группам.
 *
 * Правила:
 * - мёртвые (status=dead) и исключённые не попадают никуда;
 * - AUTO берёт только проверенные узлы (alive). Если проверенных нет вообще,
 *   AUTO собирается из непроверенных — иначе подписка останется без единого
 *   профиля в первый час после установки;
 * - BACKUP — проверенные узлы, не вошедшие в AUTO (второй эшелон). Если
 *   второго эшелона нет, туда идут непроверенные как последний резерв;
 * - ALL — все узлы, кроме мёртвых, с потолком `limit`.
 */
export function planGroups<T extends GroupNode>(
  nodes: T[],
  options: PlanOptions = {},
): Record<GroupKey, T[]> {
  const autoTop = Math.max(1, options.autoTop ?? DEFAULT_AUTO_TOP);
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);

  const usable = nodes.filter((node) => node.status !== "dead" && !node.excluded);
  const ranked = [...usable].sort(rank);
  const alive = ranked.filter((node) => node.status === "alive");

  const autoPool = alive.length > 0 ? alive : ranked;
  const auto = autoPool.slice(0, autoTop);
  const autoIds = new Set(auto.map((node) => node.id));

  const europe = ranked.filter((node) => regionOf(node.countryCode) === "europe").slice(0, limit);
  const russia = ranked.filter((node) => regionOf(node.countryCode) === "russia").slice(0, limit);

  const reserve = alive.filter((node) => !autoIds.has(node.id));
  const backupSource =
    reserve.length > 0 ? reserve : ranked.filter((node) => !autoIds.has(node.id));
  const backup = backupSource.slice(0, limit);

  return {
    auto,
    europe,
    russia,
    backup,
    all: ranked.slice(0, limit),
  };
}

export interface GroupSummary {
  total: number;
  alive: number;
  unknown: number;
  dead: number;
  missing: number;
  excluded: number;
  europe: number;
  russia: number;
  other: number;
}

/** Счётчики для админки и /status: без них «сколько серверов» — догадка. */
export function summarizeGroups(nodes: GroupNode[]): GroupSummary {
  const summary: GroupSummary = {
    total: nodes.length,
    alive: 0,
    unknown: 0,
    dead: 0,
    missing: 0,
    excluded: 0,
    europe: 0,
    russia: 0,
    other: 0,
  };
  for (const node of nodes) {
    if (node.status === "alive") summary.alive += 1;
    else if (node.status === "unknown") summary.unknown += 1;
    else summary.dead += 1;
    if (node.missing) summary.missing += 1;
    if (node.excluded) summary.excluded += 1;
    const region = regionOf(node.countryCode);
    if (region === "europe") summary.europe += 1;
    else if (region === "russia") summary.russia += 1;
    else summary.other += 1;
  }
  return summary;
}

/** Режим подписки → группа. `groups` — JSON со всеми группами сразу. */
export function isGroupMode(mode: string): mode is GroupKey {
  return (GROUP_ORDER as string[]).includes(mode);
}
