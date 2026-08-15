#!/usr/bin/env node
// Section 8: "npm run verify:events recomputes the chain for all cases and
// rebuilds projections from events; exits non-zero on mismatch. Runs in CI
// and nightly in prod."

import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { verifyAllCases } from "../src/domain/verifyEvents";

async function main() {
  const caseCount = await prisma.case.count();
  const issues = await verifyAllCases(prisma);

  for (const issue of issues) {
    console.error(`[${issue.referenceNumber}] ${issue.message}`);
  }

  console.log(`Checked ${caseCount} case(s).`);
  if (issues.length > 0) {
    console.error(`verify:events FAILED — ${issues.length} issue(s) found.`);
    process.exit(1);
  }
  console.log("verify:events OK — all event chains and projections verified.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
