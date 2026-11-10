import "../src/lib/loadEnv";
import { caseAgentEvaluationApprovalIdentity, CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY } from "../src/domain/caseAgent/evaluationApproval";
import { readPrivateCaseAgentBaselineReviewFile } from "./caseAgentBaselineReview";

function main() {
  const files = process.argv.slice(2).filter((arg) => arg.startsWith("--file="));
  const path = files[0]?.slice("--file=".length);
  if (files.length !== 1 || !path) {
    console.error("Usage: npm run agent:validate-baseline -- --file=/private/path/baseline-review.json");
    process.exitCode = 2;
    return;
  }

  const identity = caseAgentEvaluationApprovalIdentity(process.env as Record<string, string | undefined>);
  if (!identity?.startsWith(`${CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY}:remedies:`)) {
    console.error("The selected Workers AI evaluation account, model, provider terms, or complete policy is not configured locally.");
    process.exitCode = 1;
    return;
  }

  const result = readPrivateCaseAgentBaselineReviewFile(path, identity);
  if (result.blockers.length > 0 || !result.sha256) {
    console.error("Baseline review validation failed:");
    for (const blocker of result.blockers) console.error(`- ${blocker}`);
    process.exitCode = 1;
    return;
  }

  console.log("Baseline review file passed mechanical checks. This does not verify reviewer identity or replace human judgment.");
  console.log(`Baseline review artifact SHA-256: ${result.sha256}`);
}

main();
