import { WORKERS_AI_MODEL } from "../pipeline/provider";
import { REMEDIES } from "./proposal";

/** Owner-selected account for the bounded, seven-fixture synthetic evaluation. */
export const CASE_AGENT_EVALUATION_WORKERS_AI_ACCOUNT_ID = "1713c51cc6fbcf8d7143526b93495b76";

const SYNTHETIC_NOTICE_EN = "Synthetic evaluation notice: this synthetic case's text and extracted evidence are sent to the configured model provider for this test only.";
const SYNTHETIC_NOTICE_FR = "Avis d’évaluation synthétique : le texte et les preuves extraites de ce dossier synthétique sont transmis au fournisseur de modèle configuré pour ce test seulement.";

function configuredOrDefault(env: Record<string, string | undefined>, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

/**
 * Build the evaluator's isolated case-agent policy. A real deployment still
 * requires explicit values in its own environment; these defaults are only
 * for seven synthetic fixtures and are included in the review identity.
 */
export function buildCaseAgentEvaluationEnvironment(
  base: Record<string, string | undefined>,
  stub: boolean,
): Record<string, string | undefined> {
  return {
    ...base,
    ...(stub ? {
      AEQUITAS_PIPELINE_PROVIDER: "gemini",
      GEMINI_PROJECT_ID: "synthetic-evaluation-project",
      GEMINI_MODEL: "gemini-3.8-flash",
    } : {
      AEQUITAS_PIPELINE_PROVIDER: "workers-ai",
      CLOUDFLARE_ACCOUNT_ID: CASE_AGENT_EVALUATION_WORKERS_AI_ACCOUNT_ID,
      AEQUITAS_WORKERS_AI_MODEL: WORKERS_AI_MODEL,
    }),
    AEQUITAS_CASE_AGENT_ENABLED: "true",
    AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_MAX_AMOUNT_CENTS", "500000"),
    AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_ALLOWED_REMEDIES", REMEDIES.join(",")),
    AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_MAX_MODEL_CALLS_PER_UTC_DAY", "10"),
    AEQUITAS_CASE_AGENT_INTAKE_DAYS: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_INTAKE_DAYS", "1"),
    AEQUITAS_CASE_AGENT_RESPONSE_DAYS: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_RESPONSE_DAYS", "1"),
    AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_RESPONDENT_MAY_WITHDRAW", "true"),
    AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_CONSENT_ONLY_RESOLUTION", "true"),
    AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN", SYNTHETIC_NOTICE_EN),
    AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: configuredOrDefault(base, "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR", SYNTHETIC_NOTICE_FR),
    // Synthetic evaluation must never trigger an outbound email.
    RESEND_API_KEY: "",
  };
}
