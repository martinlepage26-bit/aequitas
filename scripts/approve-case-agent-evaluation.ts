import "../src/lib/loadEnv";
import { readFileSync } from "node:fs";
import { caseAgentEvaluationApprovalIdentity } from "../src/domain/caseAgent/evaluationApproval";
import { evaluationReviewBlockers } from "./caseAgentEvaluationReview";

function reviewReportPath(args: string[]): string | null {
  const index = args.findIndex((arg) => arg === "--review-report");
  const inline = args.find((arg) => arg.startsWith("--review-report="));
  if (index >= 0 && inline) return null;
  if (inline) return inline.slice("--review-report=".length) || null;
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1];
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const path = reviewReportPath(args);
  if (!path) {
    console.error("Usage: npm run agent:approve-evaluation -- --review-report <live-review.json> --confirm-human-review");
    process.exitCode = 2;
    return;
  }
  if (!args.includes("--confirm-human-review")) {
    console.error("After manually reviewing the synthetic report and completing every checklist item, rerun with --confirm-human-review.");
    process.exitCode = 2;
    return;
  }

  let report: unknown;
  try {
    report = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    console.error("Could not read a valid review report from the supplied path.");
    process.exitCode = 2;
    return;
  }

  const identity = caseAgentEvaluationApprovalIdentity(process.env as Record<string, string | undefined>);
  const blockers = evaluationReviewBlockers(report, identity);
  if (blockers.length > 0 || !identity) {
    console.error("The evaluation review is incomplete or does not match the current runtime configuration:");
    for (const blocker of blockers) console.error(`- ${blocker}`);
    process.exitCode = 1;
    return;
  }

  console.log("Validation checks passed. This command cannot prove who performed the human review; the confirmation flag is the operator's assertion.");
  console.log(`AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR=${identity}`);
}

main();
