import { getTranslations } from "next-intl/server";
import type { ClaimTypeName } from "../../../../domain/claimPresentation";
import type { ClaimGraph } from "../../../../domain/claimWrites";
import ClaimAuthorForms from "./ClaimAuthorForms";
import { ClaimsList, type ClaimsCopy } from "./ClaimsList";

const CLAIM_TYPES: ClaimTypeName[] = ["FACTUAL", "CAUSAL", "MORAL", "IDENTITY", "POLICY", "IMPACT_STATEMENT"];

export default async function ClaimsPanel({ caseId, locale, graph, complainantId, respondentId }: { caseId: string; locale: string; graph: ClaimGraph; complainantId: string; respondentId: string }) {
  const t = await getTranslations("workspace.claims");
  const tRole = await getTranslations("workspace.role");
  const copy: ClaimsCopy = {
    title: t("title"),
    description: t("description"),
    empty: t("empty"),
    needsEvidenceHeading: t("needsEvidenceHeading"),
    needsEvidenceNotice: t("needsEvidenceNotice"),
    why: t("why"),
    provenanceTitle: t("provenanceTitle"),
    excerptLabel: t("excerptLabel"),
    sourceLabel: t("sourceLabel"),
    recordedBy: t.raw("recordedBy"),
    linkRecordedBy: t.raw("linkRecordedBy"),
    redacted: t("redacted"),
    citation: t.raw("citation"),
    framework: t.raw("framework"),
    evidenceItem: t.raw("evidenceItem"),
    confidenceLabel: t("confidenceLabel"),
    statusLabel: t("statusLabel"),
    typeLabel: t("typeLabel"),
    impactNotice: t("impactNotice"),
    relationshipsTitle: t("relationshipsTitle"),
    noRelationships: t("noRelationships"),
    role: {
      complainant: tRole("complainant"),
      respondent: tRole("respondent"),
      manager: tRole("caseManager"),
    },
    type: Object.fromEntries(CLAIM_TYPES.map((key) => [key, t(`type.${key}`)])) as ClaimsCopy["type"],
    confidence: {
      ESTABLISHED: t("confidence.ESTABLISHED"),
      PROBABLE: t("confidence.PROBABLE"),
      DISPUTED: t("confidence.DISPUTED"),
      UNKNOWN: t("confidence.UNKNOWN"),
    },
    status: {
      OPEN: t("status.OPEN"),
      NEEDS_EVIDENCE: t("status.NEEDS_EVIDENCE"),
      DISPUTED: t("status.DISPUTED"),
      MERGED: t("status.MERGED"),
      SUPERSEDED: t("status.SUPERSEDED"),
      WITHDRAWN: t("status.WITHDRAWN"),
    },
    linkPredicate: {
      ORIGINATES_FROM: t("linkPredicate.ORIGINATES_FROM"),
      SUPPORTS: t("linkPredicate.SUPPORTS"),
      CONTRADICTS: t("linkPredicate.CONTRADICTS"),
      QUALIFIES: t("linkPredicate.QUALIFIES"),
    },
    relationPredicate: {
      SUPPORTS: t("relationPredicate.SUPPORTS"),
      CONTRADICTS: t("relationPredicate.CONTRADICTS"),
      QUALIFIES: t("relationPredicate.QUALIFIES"),
      INTERPRETS: t("relationPredicate.INTERPRETS"),
      EXPERIENCED_BY: t("relationPredicate.EXPERIENCED_BY"),
      OCCURRED_BEFORE: t("relationPredicate.OCCURRED_BEFORE"),
      ALLEGED_TO_HAVE_CONTRIBUTED_TO: t("relationPredicate.ALLEGED_TO_HAVE_CONTRIBUTED_TO"),
      CONSISTENT_WITH: t("relationPredicate.CONSISTENT_WITH"),
      AMPLIFIED_BY: t("relationPredicate.AMPLIFIED_BY"),
      GOVERNED_BY: t("relationPredicate.GOVERNED_BY"),
      REQUIRES_REVIEW: t("relationPredicate.REQUIRES_REVIEW"),
      UNRESOLVED_WITH: t("relationPredicate.UNRESOLVED_WITH"),
      PROPOSES_REPAIR_FOR: t("relationPredicate.PROPOSES_REPAIR_FOR"),
      CONTESTED_BY: t("relationPredicate.CONTESTED_BY"),
    },
  };

  return (
    <>
      <ClaimsList locale={locale} view={graph.view} authors={graph.authors} copy={copy} complainantId={complainantId} respondentId={respondentId} />
      {graph.canAuthor && (
        <ClaimAuthorForms
          caseId={caseId}
          locale={locale}
          sources={graph.sources}
          claims={graph.claimOptions}
          evidenceItems={graph.evidenceOptions}
        />
      )}
    </>
  );
}
