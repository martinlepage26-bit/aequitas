import "../src/lib/loadEnv";
import { readFileSync } from "node:fs";
import { caseAgentEvaluationApprovalIdentity, CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV } from "../src/domain/caseAgent/evaluationApproval";
import { evaluationReviewBlockers } from "./caseAgentEvaluationReview";
import { readPrivateCaseAgentFixtureSet } from "./privateCaseAgentFixtures";

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
  const fixtureFiles = args.filter((arg) => arg.startsWith("--fixtures-file="));
  const fixtureFilePath = fixtureFiles[0]?.slice("--fixtures-file=".length);
  if (!path || fixtureFiles.length !== 1 || !fixtureFilePath) {
    console.error("Usage: npm run agent:approve-evaluation -- --fixtures-file=/private/path/fixtures.json --review-report <live-review.json> --confirm-human-review");
    process.exitCode = 2;
    return;
  }
  if (!args.includes("--confirm-human-review")) {
    console.error("After manually reviewing the synthetic report and completing every checklist item, rerun with --confirm-human-review.");
    process.exitCode = 2;
    return;
  }

  const fixtureSet = readPrivateCaseAgentFixtureSet(fixtureFilePath);
  if (!fixtureSet.fixtures || !fixtureSet.fixtureSetSha256 || fixtureSet.blockers.length > 0) {
    console.error("The private fixture set is invalid:");
    for (const blocker of fixtureSet.blockers) console.error("- " + blocker);
    process.exitCode = 1;
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

  const env = {
    ...(process.env as Record<string, string | undefined>),
    [CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV]: fixtureSet.fixtureSetSha256,
  };
  const identity = caseAgentEvaluationApprovalIdentity(env);
  const blockers = evaluationReviewBlockers(report, identity, fixtureSet.fixtures);
  if (blockers.length > 0 || !identity) {
    console.error("The evaluation review is incomplete or does not match the current runtime configuration:");
    for (const blocker of blockers) console.error(`- ${blocker}`);
    process.exitCode = 1;
    return;
  }

  console.log("Validation checks passed. This command cannot prove who performed the human review; the confirmation flag is the operator's assertion.");
  console.log(CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV + "=" + fixtureSet.fixtureSetSha256);
  console.log(`AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR=${identity}`);
}

main();
