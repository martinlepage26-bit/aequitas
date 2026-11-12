import "../src/lib/loadEnv";
import { constants } from "node:fs";
import { closeSync, fsyncSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { caseAgentProgram } from "../src/domain/caseAgent/config";
import { buildCaseAgentEvaluationEnvironment } from "../src/domain/caseAgent/evaluationEnvironment";
import { privateCaseAgentFixturePolicyBlockers, readPrivateCaseAgentFixtureSet, renderPrivateCaseAgentBlindPacket } from "./privateCaseAgentFixtures";

function main() {
  const args = process.argv.slice(2);
  const outputs = args.filter((arg) => arg.startsWith("--out="));
  const output = outputs[0]?.slice("--out=".length);
  const fixtureFiles = args.filter((arg) => arg.startsWith("--fixtures-file="));
  const fixtureFile = fixtureFiles[0]?.slice("--fixtures-file=".length);
  if (outputs.length !== 1 || !output || fixtureFiles.length !== 1 || !fixtureFile) {
    console.error("Usage: npm run agent:blind-packet -- --fixtures-file=/private/path/fixtures.json --out=/private/path/blind-packet.md");
    process.exitCode = 2;
    return;
  }

  const fixtureSet = readPrivateCaseAgentFixtureSet(fixtureFile);
  if (!fixtureSet.fixtures || !fixtureSet.fixtureSetSha256 || fixtureSet.blockers.length > 0) {
    console.error("Could not read the private fixture set:");
    for (const blocker of fixtureSet.blockers) console.error("- " + blocker);
    process.exitCode = 1;
    return;
  }

  const env = buildCaseAgentEvaluationEnvironment(process.env as Record<string, string | undefined>, false);
  const configured = caseAgentProgram(env);
  if (!configured.ok) {
    console.error("The synthetic evaluation policy is incomplete:");
    for (const blocker of configured.missing) console.error("- " + blocker);
    process.exitCode = 1;
    return;
  }
  const policyBlockers = privateCaseAgentFixturePolicyBlockers(
    fixtureSet.fixtures,
    configured.program.maxAmountCents,
  );
  if (policyBlockers.length > 0) {
    console.error("The private fixtures do not match the configured deterministic policy:");
    for (const blocker of policyBlockers) console.error("- " + blocker);
    process.exitCode = 1;
    return;
  }

  const resolvedOutput = isAbsolute(output) ? output : "";
  if (!resolvedOutput) {
    console.error("Choose an absolute output path outside the repository.");
    process.exitCode = 2;
    return;
  }
  let path: string;
  try {
    path = join(realpathSync(dirname(resolvedOutput)), basename(resolvedOutput));
  } catch {
    console.error("The output directory must already exist and be accessible.");
    process.exitCode = 1;
    return;
  }
  const relativeToRepo = relative(process.cwd(), path);
  if (relativeToRepo === "" || relativeToRepo === ".." || !relativeToRepo.startsWith(".." + sep)) {
    console.error("Choose an absolute output path outside the repository.");
    process.exitCode = 2;
    return;
  }

  const content = renderPrivateCaseAgentBlindPacket(
    fixtureSet.fixtures,
    {
      providerIdentity: configured.program.processingDisclosure.providerIdentity,
      maxAmountCents: configured.program.maxAmountCents,
      allowedRemedies: configured.program.allowedRemedies,
      intakeDays: configured.program.intakeDays,
      responseDays: configured.program.responseDays,
      respondentMayWithdraw: configured.program.respondentMayWithdraw,
      consentOnlyResolution: configured.program.consentOnlyResolution,
      processingNoticeEn: configured.program.processingDisclosure.noticeEn,
      processingNoticeFr: configured.program.processingDisclosure.noticeFr,
    },
  );

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } catch {
    console.error("Could not create the private blind review packet; the path may already exist or its directory may be unavailable.");
    process.exitCode = 1;
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  console.log("Created an owner-private blind review packet. It contains no expected outcomes or model output.");
  console.log("Fixture-set SHA-256: " + fixtureSet.fixtureSetSha256);
}

main();
