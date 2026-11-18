/**
 * Сборка подписки по группам.
 *
 * Два представления одного и того же отбора:
 *
 * 1. JSON (для INCY, Happ и других Xray-клиентов) — массив полных конфигов,
 *    по одному на группу. Внутри каждой группы балансировщик leastPing и
 *    observatory: клиент сам замеряет задержку и уводит поток на живой узел.
 *    В списке серверов это выглядит как пять строк: AUTO, EUROPE, RUSSIA,
 *    BACKUP, ALL. Это настоящие конфиги, а не переключатели-обманки.
 *
 * 2. base64-список (для клиентов без поддержки JSON) — по одной ссылке на
 *    группу: /sub/<токен>/europe и т. д.
 *
 * Пустая группа не отдаётся вовсе: лучше меньше строк, чем строка-заглушка.
 */

import { buildAutoConfig } from "./xray_json";
import {
  GROUP_DESCRIPTIONS,
  GROUP_ORDER,
  GROUP_TITLES,
  planGroups,
  type GroupKey,
  type GroupNode,
  type PlanOptions,
} from "./groups";

export interface GroupSubscription {
  key: GroupKey;
  title: string;
  description: string;
  links: string[];
}

/** Ссылка с человеческой подписью — она же тег outbound'а в JSON. */
function labeled(link: string, label: string): string {
  const base = link.split("#")[0];
  return label ? `${base}#${encodeURIComponent(label)}` : base;
}

/** План групп: узлы уже отфильтрованы и отсортированы. */
export function buildGroupPlan(
  nodes: Array<GroupNode & { label?: string }>,
  options: PlanOptions = {},
): GroupSubscription[] {
  const plan = planGroups(nodes, options);
  const result: GroupSubscription[] = [];
  for (const key of GROUP_ORDER) {
    const groupNodes = plan[key];
    if (groupNodes.length === 0) continue;
    result.push({
      key,
      title: GROUP_TITLES[key],
      description: GROUP_DESCRIPTIONS[key],
      links: groupNodes.map((node) =>
        labeled(node.link, node.label || `${node.countryCode || "??"} · ${key.toUpperCase()}`),
      ),
    });
  }
  return result;
}

/**
 * Полная JSON-подписка: массив конфигов, по одному на группу.
 *
 * `remarks` — имя записи в клиенте (INCY читает его как метаданные полного
 * конфига). `meta.serverDescription` показывается описанием сервера.
 */
export function buildGroupsJson(
  nodes: Array<GroupNode & { label?: string }>,
  options: PlanOptions = {},
): string {
  const plan = buildGroupPlan(nodes, options);
  const configs: unknown[] = [];
  for (const group of plan) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(buildAutoConfig(group.links, group.links.length)) as Record<string, unknown>;
    } catch {
      continue;
    }
    parsed.remarks = group.title;
    parsed.meta = {
      serverDescription: `${group.description} · узлов: ${group.links.length}`,
    };
    configs.push(parsed);
  }
  return JSON.stringify(configs, null, 2);
}

/** Ссылки одной группы — для base64-подписки. */
export function buildGroupLinks(
  nodes: Array<GroupNode & { label?: string }>,
  key: GroupKey,
  options: PlanOptions = {},
): string[] {
  const plan = buildGroupPlan(nodes, options);
  return plan.find((group) => group.key === key)?.links ?? [];
}
