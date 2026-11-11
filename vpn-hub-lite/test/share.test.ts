import { describe, expect, it } from "vitest";

import { isDeliverable, isShareActive } from "../src/sub";

const future = "2099-01-01 00:00:00";
const past = "2020-01-01 00:00:00";

describe("временный общий доступ", () => {
  it("источник без срока общий всегда", () => {
    expect(isShareActive({})).toBe(true);
    expect(isShareActive({ share_until: null })).toBe(true);
  });

  it("срок в будущем — доступ открыт", () => {
    expect(isShareActive({ share_until: future })).toBe(true);
  });

  it("срок истёк — доступ закрыт", () => {
    expect(isShareActive({ share_until: past })).toBe(false);
  });

  it("после истечения серверы не уходят другим людям", () => {
    const server = {
      visibility: "shareable" as const,
      share_until: past,
      source_kind: "public" as const,
      status: "alive",
    };
    expect(isDeliverable(server, false)).toBe(false);
    // владелец источник всё равно видит
    expect(isDeliverable(server, true)).toBe(true);
  });

  it("до истечения срока server уходит всем", () => {
    const server = {
      visibility: "shareable" as const,
      share_until: future,
      source_kind: "public" as const,
      status: "alive",
    };
    expect(isDeliverable(server, false)).toBe(true);
  });
});
