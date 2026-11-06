import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const composePath = path.resolve(import.meta.dirname, "../..", "deploy/ct920/compose.yaml");

function scheduledServiceEnvironment(): Map<string, string> {
  const compose = readFileSync(composePath, "utf8");
  const start = compose.indexOf("\n  scheduler:\n");
  const end = compose.indexOf("\n  postgres:\n", start);
  if (start < 0 || end < 0) throw new Error("CT920 scheduler service is missing.");
  const service = compose.slice(start, end);
  const environmentStart = service.indexOf("\n    environment:\n");
  const environmentEnd = service.indexOf("\n    depends_on:", environmentStart);
  if (environmentStart < 0 || environmentEnd < 0) throw new Error("CT920 scheduler environment is missing.");
  const values = new Map<string, string>();
  for (const line of service.slice(environmentStart, environmentEnd).split("\n")) {
    const match = /^ {6}([A-Z][A-Z0-9_]*): (.+)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

describe("CT920 scheduled case-agent configuration", () => {
  it("forwards program, provider, and approval settings while leaving the agent off by default", () => {
    const environment = scheduledServiceEnvironment();
    const required = [
      "AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY",
      "AEQUITAS_CASE_AGENT_ENABLED",
      "AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS",
      "AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY",
      "AEQUITAS_CASE_AGENT_INTAKE_DAYS",
      "AEQUITAS_CASE_AGENT_RESPONSE_DAYS",
      "AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW",
      "AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION",
      "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN",
      "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR",
      "AEQUITAS_CASE_AGENT_EVALUATION_REVIEWED_FOR",
      "AEQUITAS_AI_PROVIDER_TERMS_REVIEWED_FOR",
      "AEQUITAS_GEMINI_PAID_TIER_CONFIRMED_FOR",
      "AEQUITAS_PIPELINE_PROVIDER",
      "GEMINI_PROJECT_ID",
      "GEMINI_API_KEY",
      "GOOGLE_AI_API_KEY",
      "GEMINI_MODEL",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "AEQUITAS_WORKERS_AI_MODEL",
    ];
    const defaults = new Map([
      ["AEQUITAS_CASE_AGENT_ENABLED", "false"],
      ["AEQUITAS_PIPELINE_PROVIDER", "gemini"],
    ]);

    for (const name of required) {
      const defaultValue = defaults.get(name) ?? "";
      expect(environment.get(name), `${name} must be forwarded from the deployment environment`)
        .toBe("${" + name + ":-" + defaultValue + "}");
    }
    expect(environment.has("SESSION_SECRET")).toBe(false);
    expect(environment.has("WEBAUTHN_RP_ID")).toBe(false);
  });
});
