import { describe, expect, it } from "vitest";

import { detectDirect, parsePlan, textOf } from "../src/ai";

describe("формат ответа Workers AI", () => {
  it("понимает OpenAI-совместимый ответ", () => {
    const result = { choices: [{ message: { content: '{"action":"stats"}' } }] };
    expect(textOf(result)).toBe('{"action":"stats"}');
  });

  it("понимает старый формат response", () => {
    expect(textOf({ response: "привет" })).toBe("привет");
  });

  it("не падает на пустом ответе", () => {
    expect(textOf(null)).toBe("");
    expect(textOf({})).toBe("");
  });

  it("понимает уже разобранный объект в response", () => {
    const result = { response: { action: "stats", args: {}, say: "ок" } };
    expect(textOf(result)).toContain('"action":"stats"');
  });
});

describe("разбор ответа модели", () => {
  it("принимает чистый JSON", () => {
    const plan = parsePlan('{"action":"stats","args":{},"say":"смотрю"}');
    expect(plan?.action).toBe("stats");
    expect(plan?.say).toBe("смотрю");
  });

  it("снимает markdown-забор", () => {
    const plan = parsePlan('```json\n{"action":"list_dead","args":{}}\n```');
    expect(plan?.action).toBe("list_dead");
  });

  it("вытаскивает объект из болтовни вокруг", () => {
    const plan = parsePlan('Конечно! {"action":"rebalance","args":{}} — готово.');
    expect(plan?.action).toBe("rebalance");
  });

  it("понимает массовую замену узлов", () => {
    const plan = parsePlan('{"action":"replace","args":{}}');
    expect(plan?.action).toBe("replace");
  });

  it("отбрасывает неизвестное действие", () => {
    expect(parsePlan('{"action":"drop_database","args":{}}')).toBeNull();
  });

  it("терпит мусор вместо JSON", () => {
    expect(parsePlan("не знаю")).toBeNull();
    expect(parsePlan("")).toBeNull();
  });

  it("не падает на битом JSON", () => {
    expect(parsePlan('{"action":"stats",')).toBeNull();
  });
});

describe("прямые команды без модели", () => {
  it("распознаёт ключ в тексте", () => {
    const direct = detectDirect("вот ключ vless://uuid@host:443?security=reality#x");
    expect(direct?.kind).toBe("key");
  });

  it("распознаёт несколько ключей", () => {
    const direct = detectDirect(
      "добавь\nvless://a@h:443#1\nvless://b@h2:443#2",
    );
    expect(direct?.kind).toBe("key");
    expect(direct?.payload.split("\n")).toHaveLength(2);
  });

  it("распознаёт ссылку-источник по просьбе", () => {
    const direct = detectDirect("добавь источник https://example.com/sub.txt");
    expect(direct?.kind).toBe("source");
    expect(direct?.payload).toBe("https://example.com/sub.txt");
  });

  it("не трогает обычный вопрос", () => {
    expect(detectDirect("что с серверами?")).toBeNull();
  });
});

import { pickTextFiles } from "../src/discover";

describe("����� ������ � �����������", () => {
  it("���� ������ ������� �� ��������", () => {
    const files = [
      { name: "Sub1.txt", path: "Sub1.txt", type: "file", size: 1000 },
      { name: "README.md", path: "README.md", type: "file", size: 900 },
      { name: "configs.txt", path: "configs.txt", type: "file", size: 5000 },
      { name: "big.txt", path: "big.txt", type: "file", size: 5000000 },
    ];
    expect(pickTextFiles(files).map((f) => f.name)).toEqual(["Sub1.txt", "configs.txt"]);
  });
});

