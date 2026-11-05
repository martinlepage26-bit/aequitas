/**
 * Program rules for the case agent. Every value comes from the deployment's
 * configuration; none has a default in code. If any is missing or invalid,
 * the agent stays off and existing cases wait for a person.
 */
type Env = Record<string, string | undefined>;

export interface CaseAgentProgram {
  /** Largest amount at stake, in CAD cents, the program lets the agent handle. */
  maxAmountCents: number;
  /** Days the evidence period stays open after the agent opens intake. */
  intakeDays: number;
  /** Days a party has to respond at each step: join after an invitation, submit a position, answer a proposal. */
  responseDays: number;
  /** Whether the respondent may end participation (the complainant always may). */
  respondentMayWithdraw: boolean;
}

const positiveInt = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function caseAgentProgram(env: Env = process.env): { ok: true; program: CaseAgentProgram } | { ok: false; missing: string[] } {
  if (env.AEQUITAS_CASE_AGENT_ENABLED !== "true") return { ok: false, missing: ["AEQUITAS_CASE_AGENT_ENABLED"] };
  const maxAmountCents = positiveInt(env.AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS);
  const intakeDays = positiveInt(env.AEQUITAS_CASE_AGENT_INTAKE_DAYS);
  const responseDays = positiveInt(env.AEQUITAS_CASE_AGENT_RESPONSE_DAYS);
  const withdraw = env.AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW;
  const missing = [
    maxAmountCents === null && "AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS",
    intakeDays === null && "AEQUITAS_CASE_AGENT_INTAKE_DAYS",
    responseDays === null && "AEQUITAS_CASE_AGENT_RESPONSE_DAYS",
    withdraw !== "true" && withdraw !== "false" && "AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW",
  ].filter((v): v is string => Boolean(v));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, program: { maxAmountCents: maxAmountCents!, intakeDays: intakeDays!, responseDays: responseDays!, respondentMayWithdraw: withdraw === "true" } };
}

export function caseAgentEnabled(env: Env = process.env): boolean {
  return caseAgentProgram(env).ok;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
