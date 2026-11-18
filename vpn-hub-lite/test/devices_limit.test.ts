import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  one: vi.fn(),
  many: vi.fn(async () => []),
  run: vi.fn(async () => ({ meta: { changes: 1 } })),
  logEvent: vi.fn(async () => undefined),
  batch: vi.fn(async () => undefined),
}));
vi.mock("../src/db", () => h);

import { touchDevice } from "../src/sub";
import type { Env } from "../src/types";

/**
 * Третье устройство.
 *
 * Правило, которое видит человек: два устройства работают, третье получает
 * заглушку «Лимит устройств (2)» и освобождается только после отвязки одного
 * из первых двух. Здесь проверяется решение, а не текст.
 */

const env = { SALT: "test-salt" } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  h.one.mockReset();
  h.run.mockResolvedValue({ meta: { changes: 1 } });
});

type RunCall = [unknown, string, ...unknown[]];

function runCalls(): RunCall[] {
  return h.run.mock.calls as unknown as RunCall[];
}

function insertParams(): unknown[] {
  const call = runCalls().find((item) => item[1].includes("INSERT INTO user_devices"));
  return call ? call.slice(2) : [];
}

describe("лимит устройств в выдаче подписки", () => {
  it("первое устройство пропускается", async () => {
    h.one
      .mockResolvedValueOnce(null) // устройства ещё нет
      .mockResolvedValueOnce({ n: 0 }); // активных ноль

    const device = await touchDevice(env, 1, "Happ/2.5 (iPhone; iOS 18.1)", 2);
    expect(device?.blocked).toBe(false);
    expect(insertParams()[3]).toBe(0);
  });

  it("второе устройство тоже пропускается", async () => {
    h.one.mockResolvedValueOnce(null).mockResolvedValueOnce({ n: 1 });
    const device = await touchDevice(env, 1, "Happ/2.5 (Android 14)", 2);
    expect(device?.blocked).toBe(false);
  });

  it("третье блокируется с причиной «лимит»", async () => {
    h.one.mockResolvedValueOnce(null).mockResolvedValueOnce({ n: 2 });
    const device = await touchDevice(env, 1, "Happ/2.5 (Windows NT 10.0)", 2);

    expect(device?.blocked).toBe(true);
    expect(device?.reason).toBe("limit");
    const params = insertParams();
    expect(params[3]).toBe(1); // blocked
    expect(params[4]).toBe("limit"); // blocked_reason
  });

  it("известное устройство не занимает новое место", async () => {
    h.one.mockResolvedValueOnce({ blocked: 0, blocked_reason: "" });
    const device = await touchDevice(env, 1, "Happ/2.5 (iPhone; iOS 18.1)", 2);

    expect(device?.blocked).toBe(false);
    expect(runCalls().some((call) => call[1].includes("INSERT INTO user_devices"))).toBe(false);
  });

  it("отвязанное вручную остаётся отвязанным", async () => {
    h.one.mockResolvedValueOnce({ blocked: 1, blocked_reason: "" });
    const device = await touchDevice(env, 1, "Happ/2.5 (iPhone; iOS 18.1)", 2);

    expect(device?.blocked).toBe(true);
    expect(device?.reason).toBe("manual");
  });

  it("без User-Agent ничего не пишет", async () => {
    const device = await touchDevice(env, 1, "", 2);
    expect(device).toBeNull();
    expect(h.run).not.toHaveBeenCalled();
  });
});
