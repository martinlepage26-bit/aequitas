import { createHash } from "node:crypto";
import { caseDataProviderApprovalIdentity } from "../pipeline/provider";
import { AGENT_PROMPT_VERSION } from "./output";

export const PROCESSING_NOTICE_EN_ENV = "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN";
export const PROCESSING_NOTICE_FR_ENV = "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR";
export const MAX_PROCESSING_NOTICE_CHARACTERS = 3000;
export const CASE_AGENT_PROCESSING_HANDOFF_NOTICE_EN = "If you ask for a person while a request to the provider is starting or in progress, it may still be sent or finish processing information already sent; a request already sent cannot be recalled. If your request is recorded before a proposal is issued, the assistant discards that run's result. An already issued proposal remains in the case record. Your request stops further automated steps and sends the case to program staff.";
export const CASE_AGENT_PROCESSING_HANDOFF_NOTICE_FR = "Si vous demandez l’intervention d’une personne au moment où une demande au fournisseur démarre ou pendant son traitement, celle-ci peut quand même être transmise ou continuer à traiter les renseignements déjà envoyés; une demande déjà transmise ne peut pas être rappelée. Si votre demande est enregistrée avant l’émission d’une proposition, l’assistant écarte le résultat de cette exécution. Une proposition déjà émise demeure au dossier. Votre demande arrête les prochaines étapes automatisées et remet le dossier au personnel du programme.";

export type CaseAgentProcessingDisclosure = {
  providerIdentity: string;
  accountOrProjectId: string;
  promptVersion: string;
  providerName: "Google Gemini" | "Google Cloud Vertex AI" | "Cloudflare Workers AI";
  modelName: string;
  processingRegion: string | null;
  noticeHash: string;
  noticeEn: string;
  noticeFr: string;
};

/**
 * A deployment must provide reviewed bilingual disclosure text before the
 * case agent can be enabled. The hash binds each party's choice to the exact
 * provider, model, prompt version, and both displayed notice variants.
 */
export function caseAgentProcessingDisclosure(
  env: Record<string, string | undefined>,
): CaseAgentProcessingDisclosure | null {
  const providerIdentity = caseDataProviderApprovalIdentity(env);
  const programNoticeEn = env[PROCESSING_NOTICE_EN_ENV]?.trim();
  const programNoticeFr = env[PROCESSING_NOTICE_FR_ENV]?.trim();
  if (!providerIdentity || !programNoticeEn || !programNoticeFr
    || programNoticeEn.length > MAX_PROCESSING_NOTICE_CHARACTERS
    || programNoticeFr.length > MAX_PROCESSING_NOTICE_CHARACTERS) return null;
  // Hash and store the complete text shown on the page, including the
  // app-supplied explanation of what happens when a person is requested.
  const noticeEn = `${programNoticeEn}\n\n${CASE_AGENT_PROCESSING_HANDOFF_NOTICE_EN}`;
  const noticeFr = `${programNoticeFr}\n\n${CASE_AGENT_PROCESSING_HANDOFF_NOTICE_FR}`;

  const [provider, accountOrProjectId, ...details] = providerIdentity.split(":");
  if (provider !== "gemini" && provider !== "workers-ai" && provider !== "vertex-ai") return null;
  const processingRegion = provider === "vertex-ai" ? details.shift() ?? null : null;
  if (provider === "vertex-ai" && !processingRegion) return null;
  const modelParts = details;
  const modelName = modelParts.join(":");
  if (!accountOrProjectId || !modelName) return null;

  const promptVersion = AGENT_PROMPT_VERSION;
  const noticeHash = createHash("sha256").update(JSON.stringify({
    providerIdentity,
    accountOrProjectId,
    promptVersion,
    noticeEn,
    noticeFr,
  })).digest("hex");

  return {
    providerIdentity,
    accountOrProjectId,
    promptVersion,
    providerName: provider === "gemini" ? "Google Gemini" : provider === "vertex-ai" ? "Google Cloud Vertex AI" : "Cloudflare Workers AI",
    modelName,
    processingRegion,
    noticeHash,
    noticeEn,
    noticeFr,
  };
}

export function processingConsentMatches(payload: unknown, disclosure: CaseAgentProcessingDisclosure): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const noticeText = record.locale === "en-CA"
    ? disclosure.noticeEn
    : record.locale === "fr-CA"
      ? disclosure.noticeFr
      : null;
  return record.providerIdentity === disclosure.providerIdentity
    && record.promptVersion === disclosure.promptVersion
    && record.noticeHash === disclosure.noticeHash
    && noticeText !== null
    && record.noticeText === noticeText;
}

