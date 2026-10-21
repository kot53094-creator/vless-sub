import { describe, expect, it } from "vitest";

import { rankCandidates, type Candidate } from "../src/balance";

const server = (id: number, load: number, max = 10, latency: number | null = 100): Candidate => ({
  id,
  load,
  max_users: max,
  latency_ms: latency,
});

describe("балансировка", () => {
  it("берёт наименее загруженные серверы", () => {
    const picked = rankCandidates([server(1, 9), server(2, 1), server(3, 5)], 2);
    expect(picked).toEqual([2, 3]);
  });

  it("считает по проценту, а не по абсолюту", () => {
    // 5/100 = 5% загружен меньше, чем 2/10 = 20%
    const picked = rankCandidates([server(1, 2, 10), server(2, 5, 100)], 1);
    expect(picked).toEqual([2]);
  });

  it("не выдаёт сервер сверх max_users", () => {
    const picked = rankCandidates([server(1, 10, 10), server(2, 3, 10)], 5);
    expect(picked).toEqual([2]);
  });

  it("при равной загрузке выбирает с меньшей задержкой", () => {
    const picked = rankCandidates([server(1, 1, 10, 200), server(2, 1, 10, 40)], 1);
    expect(picked).toEqual([2]);
  });

  it("возвращает пустой список, если места нет", () => {
    expect(rankCandidates([server(1, 10, 10), server(2, 5, 5)], 3)).toEqual([]);
  });

  it("не выдаёт больше, чем просили, и не больше, чем есть", () => {
    expect(rankCandidates([server(1, 0), server(2, 0)], 3)).toHaveLength(2);
    expect(rankCandidates([server(1, 0), server(2, 0), server(3, 0)], 2)).toHaveLength(2);
  });
});
