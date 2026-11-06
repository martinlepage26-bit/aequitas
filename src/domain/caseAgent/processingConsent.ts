import { createHash } from "node:crypto";
import { caseDataProviderApprovalIdentity } from "../pipeline/provider";
import { AGENT_PROMPT_VERSION } from "./output";

export const PROCESSING_NOTICE_EN_ENV = "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN";
export const PROCESSING_NOTICE_FR_ENV = "AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR";
export const MAX_PROCESSING_NOTICE_CHARACTERS = 3000;

export type CaseAgentProcessingDisclosure = {
  providerIdentity: string;
  accountOrProjectId: string;
  promptVersion: string;
  providerName: "Google Gemini" | "Cloudflare Workers AI";
  modelName: string;
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
  const noticeEn = env[PROCESSING_NOTICE_EN_ENV]?.trim();
  const noticeFr = env[PROCESSING_NOTICE_FR_ENV]?.trim();
  if (!providerIdentity || !noticeEn || !noticeFr
    || noticeEn.length > MAX_PROCESSING_NOTICE_CHARACTERS
    || noticeFr.length > MAX_PROCESSING_NOTICE_CHARACTERS) return null;

  const [provider, accountOrProjectId, ...modelParts] = providerIdentity.split(":");
  if (provider !== "gemini" && provider !== "workers-ai") return null;
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
    providerName: provider === "gemini" ? "Google Gemini" : "Cloudflare Workers AI",
    modelName,
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

