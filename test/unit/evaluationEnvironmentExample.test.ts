import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const envExamplePath = path.resolve(import.meta.dirname, "../..", ".env.example");

describe("live evaluation environment example", () => {
  it("documents the one-run approval gate without enabling it by default", () => {
    const example = readFileSync(envExamplePath, "utf8");
    expect(example).toMatch(/^# AEQUITAS_CASE_AGENT_EVAL_APPROVED=true$/m);
    expect(example).not.toMatch(/^AEQUITAS_CASE_AGENT_EVAL_APPROVED=/m);
  });
});
