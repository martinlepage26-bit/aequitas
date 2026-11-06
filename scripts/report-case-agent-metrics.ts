import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";
import { summarizeCaseAgentOutcomes, summarizeCaseAgentTimings, type CaseAgentOutcomeEvent } from "../src/domain/caseAgent/metrics";

function parseDay(value: string | undefined, flag: string): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${flag} must be a UTC calendar date in YYYY-MM-DD format.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${flag} must be a valid UTC calendar date.`);
  }
  return date;
}

function parseWindow(argv: string[]): { from: Date; to: Date } {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(from|to)=(.+)$/.exec(argument);
    if (!match || values.has(match[1])) throw new Error("Use --from=YYYY-MM-DD and --to=YYYY-MM-DD exactly once each.");
    values.set(match[1], match[2]);
  }
  const from = parseDay(values.get("from"), "--from");
  const to = parseDay(values.get("to"), "--to");
  if (to <= from) throw new Error("--to must be later than --from; the end date is exclusive.");
  return { from, to };
}

async function main() {
  let window: ReturnType<typeof parseWindow>;
  try {
    window = parseWindow(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid date window.");
    process.exitCode = 2;
    return;
  }

  try {
    const intakeStarts = await prisma.event.findMany({
      where: {
        createdAt: { gte: window.from, lt: window.to },
        type: "EVIDENCE_INTAKE_OPENED",
        case: { is: { agentManaged: true, simulated: false } },
      },
      select: { caseId: true },
      orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
    });
    const intakeCaseIds = [...new Set(intakeStarts.map((event) => event.caseId))];
    const intakeEvents = intakeCaseIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        caseId: { in: intakeCaseIds },
        createdAt: { lt: window.to },
        type: { in: ["EVIDENCE_INTAKE_OPENED", "RECOMMENDATION_ISSUED"] },
      },
      select: { caseId: true, type: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
    });
    const summary = summarizeCaseAgentTimings(intakeEvents.map((event) => ({
      caseId: event.caseId,
      type: event.type as "EVIDENCE_INTAKE_OPENED" | "RECOMMENDATION_ISSUED",
      createdAt: event.createdAt,
    })));

    const enrolled = await prisma.event.findMany({
      where: {
        createdAt: { gte: window.from, lt: window.to },
        type: "AGENT_ENROLLED",
        case: { is: { agentManaged: true, simulated: false } },
      },
      select: { caseId: true },
      orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
    });
    const cohortCaseIds = [...new Set(enrolled.map((event) => event.caseId))];
    const lifecycleEvents = cohortCaseIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        caseId: { in: cohortCaseIds },
        createdAt: { lt: window.to },
        type: { in: ["AGENT_ENROLLED", "RECOMMENDATION_ISSUED", "AGENT_ESCALATED", "CASE_CLOSED"] },
      },
      select: { caseId: true, type: true, createdAt: true, seq: true, payload: true },
      orderBy: [{ caseId: "asc" }, { createdAt: "asc" }, { seq: "asc" }],
    });
    const agentOutcomes = summarizeCaseAgentOutcomes(lifecycleEvents.map((event) => ({
      caseId: event.caseId,
      type: event.type as CaseAgentOutcomeEvent["type"],
      createdAt: event.createdAt,
      seq: event.seq,
      payload: event.payload,
    })));
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      fromInclusive: window.from.toISOString(),
      toExclusive: window.to.toISOString(),
      unit: "hours",
      intakeToProposal: {
        cohort: "non-simulated agent-managed cases with evidence intake opened in the selected UTC window; lifecycle events observed before the exclusive end date",
        ...summary,
      },
      agentOutcomes: {
        cohort: "non-simulated agent-managed cases enrolled in the selected UTC window; outcomes observed before the exclusive end date",
        ...agentOutcomes,
      },
    }));
  } catch {
    console.error("Case-agent timing metrics could not be read.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
