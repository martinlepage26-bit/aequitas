import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const envExamplePath = path.resolve(import.meta.dirname, "../..", ".env.example");

describe("live evaluation environment example", () => {
  it("keeps single-run spend authorization out of persistent environment configuration", () => {
    const example = readFileSync(envExamplePath, "utf8");
    expect(example).toMatch(/one-command spend confirmation/);
    expect(example).not.toMatch(/^#?\s*AEQUITAS_CASE_AGENT_EVAL_APPROVED=/m);
    expect(example).not.toMatch(/^AEQUITAS_CASE_AGENT_EVAL_APPROVED=/m);
    expect(example).toMatch(/^# AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR=$/m);
    expect(example).not.toMatch(/^AEQUITAS_CASE_AGENT_BASELINE_REVIEWED_FOR=/m);
  });
});
