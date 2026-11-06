/**
 * Program rules for the case agent. Every value comes from the deployment's
 * configuration; none has a default in code. If any is missing or invalid,
 * the agent stays off and existing cases wait for a person.
 */
type Env = Record<string, string | undefined>;

export interface CaseAgentProgram {
  /** Largest amount at stake, in CAD cents, the program lets the agent handle. */
  maxAmountCents: number;
  /** Maximum number of outbound model-call attempts across this deployment per UTC day. */
  maxModelCallsPerUtcDay: number;
  /** Maximum days to complete evidence intake; an incomplete file goes to a person at expiry. */
  intakeDays: number;
  /** Days a party has to respond at each step: join after an invitation, submit a position, answer a proposal. */
  responseDays: number;
  /** Whether the respondent may end participation (the complainant always may). */
  respondentMayWithdraw: boolean;
  /** Whether both parties' consent may resolve the agent-managed case without independent approver sign-off. */
  consentOnlyResolution: boolean;
}

const positiveInt = (value: string | undefined) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function caseAgentProgram(env: Env = process.env): { ok: true; program: CaseAgentProgram } | { ok: false; missing: string[] } {
  if (env.AEQUITAS_CASE_AGENT_ENABLED !== "true") return { ok: false, missing: ["AEQUITAS_CASE_AGENT_ENABLED"] };
  const maxAmountCents = positiveInt(env.AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS);
  const maxModelCallsPerUtcDay = positiveInt(env.AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY);
  const intakeDays = positiveInt(env.AEQUITAS_CASE_AGENT_INTAKE_DAYS);
  const responseDays = positiveInt(env.AEQUITAS_CASE_AGENT_RESPONSE_DAYS);
  const withdraw = env.AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW;
  const consentOnly = env.AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION;
  const missing = [
    maxAmountCents === null && "AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS",
    (maxModelCallsPerUtcDay === null || maxModelCallsPerUtcDay > 2_147_483_647) && "AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY",
    intakeDays === null && "AEQUITAS_CASE_AGENT_INTAKE_DAYS",
    responseDays === null && "AEQUITAS_CASE_AGENT_RESPONSE_DAYS",
    withdraw !== "true" && withdraw !== "false" && "AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW",
    consentOnly !== "true" && consentOnly !== "false" && "AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION",
  ].filter((v): v is string => Boolean(v));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, program: { maxAmountCents: maxAmountCents!, maxModelCallsPerUtcDay: maxModelCallsPerUtcDay!, intakeDays: intakeDays!, responseDays: responseDays!, respondentMayWithdraw: withdraw === "true", consentOnlyResolution: consentOnly === "true" } };
}

export function caseAgentEnabled(env: Env = process.env): boolean {
  return caseAgentProgram(env).ok;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
