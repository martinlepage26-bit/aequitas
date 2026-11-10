import "../src/lib/loadEnv";
import { constants } from "node:fs";
import { closeSync, fsyncSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  caseAgentEvaluationApprovalIdentity,
  CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY,
} from "../src/domain/caseAgent/evaluationApproval";
import { blankCaseAgentBaselineReview } from "./caseAgentBaselineReview";

function main() {
  const outputs = process.argv.slice(2).filter((arg) => arg.startsWith("--out="));
  const output = outputs[0]?.slice("--out=".length);
  if (outputs.length !== 1 || !output) {
    console.error("Usage: npm run agent:baseline-template -- --out=/private/path/baseline-review.json");
    process.exitCode = 2;
    return;
  }

  const identity = caseAgentEvaluationApprovalIdentity(process.env as Record<string, string | undefined>);
  if (!identity?.startsWith(`${CASE_AGENT_SELECTED_EVALUATION_PROVIDER_IDENTITY}:remedies:`)) {
    console.error("Could not create the template: configure the selected Workers AI evaluation account, model, provider terms, and complete synthetic evaluation policy locally first.");
    process.exitCode = 1;
    return;
  }

  const resolvedPath = resolve(output);
  let path: string;
  try {
    path = join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
  } catch {
    console.error("The output directory must already exist and be accessible.");
    process.exitCode = 1;
    return;
  }
  const relativeToRepo = relative(process.cwd(), path);
  if (!isAbsolute(output) || (relativeToRepo !== ".." && !relativeToRepo.startsWith(`..${sep}`))) {
    console.error("Choose an absolute output path outside the repository so private reviewer notes cannot be committed.");
    process.exitCode = 2;
    return;
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(blankCaseAgentBaselineReview(identity), null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } catch {
    console.error("Could not create the private baseline review file; the path may already exist or its directory may be unavailable.");
    process.exitCode = 1;
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  console.log(`Created a blank private baseline review file at ${path}. It contains no reviewer findings and does not authorize a model call.`);
  console.log(`Evaluation identity: ${identity}`);
}

main();
