import { describe, expect, it } from "vitest";
import { retentionReviewAt } from "../../src/domain/retentionPolicy";

describe("measured retention review dates", () => {
  it("uses the first calendar anniversary and preserves the UTC time", () => {
    expect(retentionReviewAt(new Date("2025-11-01T12:34:56.789Z")).toISOString()).toBe("2026-11-01T12:34:56.789Z");
    expect(retentionReviewAt(new Date("2024-02-29T23:59:59.999Z")).toISOString()).toBe("2025-02-28T23:59:59.999Z");
    expect(retentionReviewAt(new Date("2023-03-01T00:00:00.000Z")).toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });
});
