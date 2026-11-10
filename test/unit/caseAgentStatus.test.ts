import { describe, expect, it } from "vitest";
import { caseAgentOperationallyReady } from "../../src/domain/caseAgent/statusReadiness";

describe("case-agent operational readiness", () => {
  const ready = {
    programConfigured: true,
    modelConfigured: true,
    serviceAccountCount: 1,
    emailConfigured: true,
    workerHealth: "healthy" as const,
  };

  it("requires each runtime prerequisite", () => {
    expect(caseAgentOperationallyReady(ready)).toBe(true);
    expect(caseAgentOperationallyReady({ ...ready, programConfigured: false })).toBe(false);
    expect(caseAgentOperationallyReady({ ...ready, modelConfigured: false })).toBe(false);
    expect(caseAgentOperationallyReady({ ...ready, serviceAccountCount: 0 })).toBe(false);
    expect(caseAgentOperationallyReady({ ...ready, serviceAccountCount: 2 })).toBe(false);
    expect(caseAgentOperationallyReady({ ...ready, emailConfigured: false })).toBe(false);
  });

  it("accepts a live worker run and rejects unhealthy schedule states", () => {
    expect(caseAgentOperationallyReady({ ...ready, workerHealth: "running" })).toBe(true);
    for (const workerHealth of ["never_run", "stalled", "overdue", "failed", "interrupted", "unknown"] as const) {
      expect(caseAgentOperationallyReady({ ...ready, workerHealth })).toBe(false);
    }
  });
});
