import { describe, expect, it } from "vitest";
import { caseAgentProcessingDisclosure, processingConsentMatches } from "../../src/domain/caseAgent/processingConsent";
import { AGENT_PROMPT_VERSION } from "../../src/domain/caseAgent/output";

const env: Record<string, string | undefined> = {
  AEQUITAS_PIPELINE_PROVIDER: "gemini",
  GEMINI_PROJECT_ID: "synthetic-project",
  GEMINI_MODEL: "gemini-3.8-flash",
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Synthetic English notice.",
  AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis synthétique en français.",
};

describe("case-agent processing choice", () => {
  it("binds an accepted localized notice to the provider, project, model and prompt version", () => {
    const disclosure = caseAgentProcessingDisclosure(env);
    expect(disclosure).toMatchObject({
      providerIdentity: "gemini:synthetic-project:gemini-3.8-flash",
      accountOrProjectId: "synthetic-project",
      modelName: "gemini-3.8-flash",
      promptVersion: AGENT_PROMPT_VERSION,
      noticeEn: env.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN,
      noticeFr: env.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR,
    });
    if (!disclosure) throw new Error("Synthetic disclosure should be configured.");

    const accepted = {
      providerIdentity: disclosure.providerIdentity,
      promptVersion: disclosure.promptVersion,
      noticeHash: disclosure.noticeHash,
      noticeText: disclosure.noticeFr,
      locale: "fr-CA",
    };
    expect(processingConsentMatches(accepted, disclosure)).toBe(true);
    expect(processingConsentMatches({ ...accepted, noticeText: disclosure.noticeEn }, disclosure)).toBe(false);
    expect(processingConsentMatches({ ...accepted, locale: "es-ES" }, disclosure)).toBe(false);

    const changedNotice = caseAgentProcessingDisclosure({ ...env, AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Changed French notice." });
    const changedProject = caseAgentProcessingDisclosure({ ...env, GEMINI_PROJECT_ID: "another-project" });
    const changedModel = caseAgentProcessingDisclosure({ ...env, GEMINI_MODEL: "another-model" });
    expect(changedNotice && processingConsentMatches(accepted, changedNotice)).toBe(false);
    expect(changedProject && processingConsentMatches(accepted, changedProject)).toBe(false);
    expect(changedModel && processingConsentMatches(accepted, changedModel)).toBe(false);
  });

  it("fails closed when provider identity or either bilingual notice is missing", () => {
    expect(caseAgentProcessingDisclosure({ ...env, GEMINI_PROJECT_ID: undefined })).toBeNull();
    expect(caseAgentProcessingDisclosure({ ...env, AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "  " })).toBeNull();
    expect(caseAgentProcessingDisclosure({ ...env, AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: undefined })).toBeNull();
  });
});
