import { describe, expect, it } from "vitest";
import {
  planGroups,
  regionOf,
  summarizeGroups,
  GROUP_ORDER,
  type GroupNode,
} from "../src/groups";
import { buildGroupLinks, buildGroupsJson } from "../src/sub_groups";

function node(
  id: string,
  countryCode: string,
  status: GroupNode["status"],
  latencyMs: number | null = null,
  extra: Partial<GroupNode> = {},
): GroupNode & { label: string } {
  return {
    id,
    link: `vless://00000000-0000-4000-8000-0000000000${id}@${id}.example.com:443?encryption=none&security=reality&sni=${id}.example.com&pbk=KEY#${id}`,
    countryCode,
    status,
    latencyMs,
    label: `${countryCode} ${id}`,
    ...extra,
  };
}

describe("regionOf", () => {
  it("относит Россию к russia, а не к Европе", () => {
    expect(regionOf("RU")).toBe("russia");
    expect(regionOf("ru")).toBe("russia");
  });

  it("распознаёт европейские коды", () => {
    for (const cc of ["DE", "NL", "FI", "PL", "GB", "UA", "BY", "CH"]) {
      expect(regionOf(cc)).toBe("europe");
    }
  });

  it("не записывает спорные гео в Европу", () => {
    for (const cc of ["KZ", "GE", "AM", "AZ", "TR", "US", "SG"]) {
      expect(regionOf(cc)).toBe("other");
    }
  });

  it("пустой код не падает", () => {
    expect(regionOf("")).toBe("other");
    expect(regionOf(null)).toBe("other");
  });
});

describe("planGroups", () => {
  const nodes = [
    node("01", "DE", "alive", 40),
    node("02", "NL", "alive", 60),
    node("03", "RU", "alive", 20),
    node("04", "FI", "alive", 120),
    node("05", "US", "unknown", null),
    node("06", "PL", "dead", 10),
    node("07", "RU", "alive", 90, { missing: true }),
    node("08", "SE", "alive", 200, { excluded: true }),
  ];

  it("мёртвые и исключённые не попадают ни в одну группу", () => {
    const plan = planGroups(nodes, { autoTop: 3, limit: 10 });
    const ids = new Set(GROUP_ORDER.flatMap((key) => plan[key].map((item) => item.id)));
    expect(ids.has("06")).toBe(false);
    expect(ids.has("08")).toBe(false);
  });

  it("AUTO берёт только проверенные и сортирует по задержке", () => {
    const plan = planGroups(nodes, { autoTop: 3, limit: 10 });
    expect(plan.auto.map((item) => item.id)).toEqual(["03", "01", "02"]);
  });

  it("EUROPE не содержит Россию и мёртвые узлы", () => {
    const plan = planGroups(nodes, { autoTop: 2, limit: 10 });
    expect(plan.europe.map((item) => item.id)).toEqual(["01", "02", "04"]);
  });

  it("RUSSIA содержит только российские узлы", () => {
    const plan = planGroups(nodes, { autoTop: 2, limit: 10 });
    expect(plan.russia.map((item) => item.id)).toEqual(["03", "07"]);
  });

  it("BACKUP — проверенные узлы вне AUTO", () => {
    const plan = planGroups(nodes, { autoTop: 2, limit: 10 });
    // AUTO: 03, 01. Резерв: 02, 04 (07 помечен missing, но живой и тоже в резерве).
    expect(plan.backup.map((item) => item.id)).toEqual(["02", "07", "04"]);
  });

  it("ALL ограничен потолком и не содержит мёртвых", () => {
    const plan = planGroups(nodes, { autoTop: 2, limit: 4 });
    expect(plan.all).toHaveLength(4);
    expect(plan.all.map((item) => item.id)).not.toContain("06");
  });

  it("без проверенных узлов AUTO не остаётся пустым", () => {
    const plan = planGroups([node("11", "DE", "unknown")], { autoTop: 3 });
    expect(plan.auto.map((item) => item.id)).toEqual(["11"]);
  });

  it("пустой пул даёт пустые группы, а не падение", () => {
    const plan = planGroups([]);
    for (const key of GROUP_ORDER) expect(plan[key]).toEqual([]);
  });
});

describe("summarizeGroups", () => {
  it("считает статусы, гео и служебные флаги", () => {
    const summary = summarizeGroups([
      node("01", "DE", "alive"),
      node("02", "RU", "alive"),
      node("03", "US", "unknown", null, { missing: true }),
      node("04", "FR", "dead", null, { excluded: true }),
    ]);
    expect(summary).toMatchObject({
      total: 4,
      alive: 2,
      unknown: 1,
      dead: 1,
      missing: 1,
      excluded: 1,
      europe: 2,
      russia: 1,
      other: 1,
    });
  });
});

describe("сборка подписки по группам", () => {
  const nodes = [
    node("01", "DE", "alive", 30),
    node("02", "RU", "alive", 50),
    node("03", "US", "alive", 80),
  ];

  it("JSON содержит профили с балансировщиком и именем группы", () => {
    const raw = buildGroupsJson(nodes, { autoTop: 2, limit: 10 });
    const configs = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(configs.length).toBeGreaterThanOrEqual(3);
    expect(configs[0].remarks).toBe("AUTO · Апельсинка");
    const routing = configs[0].routing as { balancers: Array<{ strategy: { type: string } }> };
    expect(routing.balancers[0].strategy.type).toBe("leastPing");
    expect(configs[0].observatory).toBeTruthy();
    const outbounds = configs[0].outbounds as Array<{ protocol: string }>;
    expect(outbounds.some((item) => item.protocol === "freedom")).toBe(true);
  });

  it("каждый профиль — полный конфиг: inbounds и outbounds", () => {
    const configs = JSON.parse(buildGroupsJson(nodes)) as Array<Record<string, unknown>>;
    for (const config of configs) {
      expect(Array.isArray(config.inbounds)).toBe(true);
      expect(Array.isArray(config.outbounds)).toBe(true);
    }
  });

  it("отдельная группа отдаёт только свои ссылки", () => {
    const europe = buildGroupLinks(nodes, "europe", { limit: 10 });
    expect(europe).toHaveLength(1);
    expect(decodeURIComponent(europe[0])).toContain("DE 01");
  });

  it("пустая группа не превращается в мусорную строку", () => {
    expect(buildGroupLinks([node("09", "US", "dead")], "russia")).toEqual([]);
  });
});
