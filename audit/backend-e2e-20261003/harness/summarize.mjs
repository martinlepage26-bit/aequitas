// Builds evidence/summary.json and evidence/summary.md from the vitest JSON results and the observation logs.
// Usage: node summarize.mjs   (run from the repository root after run-all.sh)
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const EV = "audit/backend-e2e-20261003/evidence";
const suites = [];
for (const file of readdirSync(join(EV, "results")).filter((f) => f.endsWith(".json")).sort()) {
  const r = JSON.parse(readFileSync(join(EV, "results", file), "utf8"));
  const tests = r.testResults.flatMap((t) => t.assertionResults.map((a) => ({
    name: a.fullName.replace(/^.*?\.audit\.ts > /, "").replace(/^.*?> /, ""),
    full: a.fullName.replace(/^\S*\.audit\.ts\s*/, ""),
    status: a.status,
    ms: a.duration ?? 0,
    failure: a.status === "failed" ? (a.failureMessages?.[0] ?? "").replace(/\s+/g, " ").slice(0, 600) : undefined,
  })));
  suites.push({ suite: file.replace(/\.json$/, ""), total: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests, tests });
}
const totals = suites.reduce((a, s) => ({ total: a.total + s.total, passed: a.passed + s.passed, failed: a.failed + s.failed }), { total: 0, passed: 0, failed: 0 });

const observations = {};
const obsDir = join(EV, "observations");
if (existsSync(obsDir)) for (const f of readdirSync(obsDir).filter((x) => x.endsWith(".jsonl"))) for (const line of readFileSync(join(obsDir, f), "utf8").split("\n").filter(Boolean)) { const d = JSON.parse(line); observations[d.id] = d; delete d.t; }

writeFileSync(join(EV, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), totals, suites: suites.map(({ tests, ...s }) => ({ ...s, failedTests: tests.filter((t) => t.status === "failed").map((t) => ({ name: t.full, failure: t.failure })) })), observations }, null, 1));
const lines = ["| Suite | Tests | Passed | Failed |", "|---|---:|---:|---:|", ...suites.map((s) => `| ${s.suite} | ${s.total} | ${s.passed} | ${s.failed} |`), `| **Total** | **${totals.total}** | **${totals.passed}** | **${totals.failed}** |`, "", "## Failing tests (each is a confirmed finding or a facet of one)", ""];
for (const s of suites) for (const t of s.tests.filter((x) => x.status === "failed")) lines.push(`- \`${s.suite}\` — ${t.full}`);
writeFileSync(join(EV, "summary.md"), lines.join("\n") + "\n");
console.log(lines.slice(0, suites.length + 4).join("\n"));
