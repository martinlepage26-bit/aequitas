import "../src/lib/loadEnv";
import { caseAgentEvaluationApprovalIdentity, CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV, CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY } from "../src/domain/caseAgent/evaluationApproval";
import { readPrivateCaseAgentBaselineReviewFile } from "./caseAgentBaselineReview";
import { readPrivateCaseAgentFixtureSet } from "./privateCaseAgentFixtures";

function main() {
  const files = process.argv.slice(2).filter((arg) => arg.startsWith("--file="));
  const path = files[0]?.slice("--file=".length);
  const fixtureFiles = process.argv.slice(2).filter((arg) => arg.startsWith("--fixtures-file="));
  const fixturePath = fixtureFiles[0]?.slice("--fixtures-file=".length);
  if (files.length !== 1 || !path || fixtureFiles.length !== 1 || !fixturePath) {
    console.error("Usage: npm run agent:validate-baseline -- --fixtures-file=/private/path/fixtures.json --file=/private/path/baseline-review.json");
    process.exitCode = 2;
    return;
  }

  const fixtureSet = readPrivateCaseAgentFixtureSet(fixturePath);
  if (!fixtureSet.fixtures || !fixtureSet.fixtureSetSha256 || fixtureSet.blockers.length > 0) {
    console.error("The private fixture set is invalid:");
    for (const blocker of fixtureSet.blockers) console.error("- " + blocker);
    process.exitCode = 1;
    return;
  }
  const env = {
    ...(process.env as Record<string, string | undefined>),
    [CASE_AGENT_EVALUATION_FIXTURE_SET_SHA256_ENV]: fixtureSet.fixtureSetSha256,
  };
  const identity = caseAgentEvaluationApprovalIdentity(env);
  if (!identity?.startsWith(`${CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY}:remedies:`)) {
    console.error("The selected Workers AI evaluation account, model, provider terms, or complete policy is not configured locally.");
    process.exitCode = 1;
    return;
  }

  const result = readPrivateCaseAgentBaselineReviewFile(
    path,
    identity,
    fixtureSet.fixtures,
    fixtureSet.fixtureSetSha256,
  );
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
