import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CASE_AGENT_PROCESSING_HANDOFF_NOTICE_EN,
  CASE_AGENT_PROCESSING_HANDOFF_NOTICE_FR,
  caseAgentProcessingDisclosure,
  processingConsentMatches,
} from "../../src/domain/caseAgent/processingConsent";
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
      processingRegion: null,
      promptVersion: AGENT_PROMPT_VERSION,
      noticeEn: `${env.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN}\n\n${CASE_AGENT_PROCESSING_HANDOFF_NOTICE_EN}`,
      noticeFr: `${env.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR}\n\n${CASE_AGENT_PROCESSING_HANDOFF_NOTICE_FR}`,
    });
    if (!disclosure) throw new Error("Synthetic disclosure should be configured.");
    expect(disclosure.noticeHash).toBe(createHash("sha256").update(JSON.stringify({
      providerIdentity: "gemini:synthetic-project:gemini-3.8-flash",
      accountOrProjectId: "synthetic-project",
      promptVersion: AGENT_PROMPT_VERSION,
      noticeEn: `Synthetic English notice.\n\n${CASE_AGENT_PROCESSING_HANDOFF_NOTICE_EN}`,
      noticeFr: `Avis synthétique en français.\n\n${CASE_AGENT_PROCESSING_HANDOFF_NOTICE_FR}`,
    })).digest("hex"));

    const accepted = {
      providerIdentity: disclosure.providerIdentity,
      promptVersion: disclosure.promptVersion,
      noticeHash: disclosure.noticeHash,
      noticeText: disclosure.noticeFr,
      locale: "fr-CA",
    };
    expect(processingConsentMatches(accepted, disclosure)).toBe(true);
    expect(processingConsentMatches({ ...accepted, noticeText: env.AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR }, disclosure)).toBe(false);
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

  it("shows and binds the Vertex model-processing region to both parties' choice", () => {
    const vertexEnv = {
      AEQUITAS_PIPELINE_PROVIDER: "vertex-ai",
      AEQUITAS_VERTEX_PROJECT_ID: "synthetic-project",
      AEQUITAS_VERTEX_LOCATION: "northamerica-northeast1",
      AEQUITAS_VERTEX_MODEL: "gemini-3.5-flash",
      AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_EN: "Synthetic Vertex notice.",
      AEQUITAS_CASE_AGENT_PROCESSING_NOTICE_FR: "Avis Vertex synthétique.",
    };
    const disclosure = caseAgentProcessingDisclosure(vertexEnv);
    expect(disclosure).toMatchObject({
      providerIdentity: "vertex-ai:synthetic-project:northamerica-northeast1:gemini-3.5-flash",
      providerName: "Google Cloud Vertex AI",
      accountOrProjectId: "synthetic-project",
      modelName: "gemini-3.5-flash",
      processingRegion: "northamerica-northeast1",
    });
    if (!disclosure) throw new Error("Synthetic Vertex disclosure should be configured.");

    const accepted = {
      providerIdentity: disclosure.providerIdentity,
      promptVersion: disclosure.promptVersion,
      noticeHash: disclosure.noticeHash,
      noticeText: disclosure.noticeEn,
      locale: "en-CA",
    };
    expect(processingConsentMatches(accepted, disclosure)).toBe(true);
    expect(caseAgentProcessingDisclosure({ ...vertexEnv, AEQUITAS_VERTEX_LOCATION: "us-central1" })).toBeNull();
  });
});
