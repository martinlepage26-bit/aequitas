"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./workspace.module.css";

const SOURCE_KINDS = ["DOCUMENT", "MESSAGE", "TESTIMONY", "POLICY", "RECORD", "URL", "EVIDENCE_ITEM", "STATUTE"] as const;
const CLAIM_TYPES = ["FACTUAL", "CAUSAL", "MORAL", "IDENTITY", "POLICY", "IMPACT_STATEMENT"] as const;
const CONFIDENCE = ["UNKNOWN", "DISPUTED", "PROBABLE", "ESTABLISHED"] as const;
const LINK_PREDICATES = ["ORIGINATES_FROM", "SUPPORTS", "CONTRADICTS", "QUALIFIES"] as const;
const RELATION_PREDICATES = [
  "SUPPORTS", "CONTRADICTS", "QUALIFIES", "INTERPRETS", "EXPERIENCED_BY", "OCCURRED_BEFORE",
  "ALLEGED_TO_HAVE_CONTRIBUTED_TO", "CONSISTENT_WITH", "AMPLIFIED_BY", "GOVERNED_BY",
  "REQUIRES_REVIEW", "UNRESOLVED_WITH", "PROPOSES_REPAIR_FOR", "CONTESTED_BY",
] as const;

export default function ClaimAuthorForms({
  caseId,
  locale,
  sources,
  claims,
  evidenceItems,
}: {
  caseId: string;
  locale: string;
  sources: Array<{ id: string; title: string }>;
  claims: Array<{ id: string; text: string }>;
  evidenceItems: Array<{ id: string; title: string }>;
}) {
  const t = useTranslations("workspace.claims");
  const router = useRouter();

  return (
    <div className={styles.form}>
      <SourceForm caseId={caseId} locale={locale} evidenceItems={evidenceItems} t={t} refresh={() => router.refresh()} />
      <ClaimForm caseId={caseId} locale={locale} t={t} refresh={() => router.refresh()} />
      <LinkForm caseId={caseId} sources={sources} claims={claims} t={t} refresh={() => router.refresh()} />
      <RelationshipForm caseId={caseId} claims={claims} t={t} refresh={() => router.refresh()} />
      <ReviewForm caseId={caseId} claims={claims} t={t} refresh={() => router.refresh()} />
    </div>
  );
}

type Translator = ReturnType<typeof useTranslations<"workspace.claims">>;

function useSaver(url: string, body: () => Record<string, unknown>, refresh: () => void) {
  const [status, setStatus] = useState<"idle" | "busy" | "error" | "success">("idle");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (status === "busy") return;
    setStatus("busy");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      if (!response.ok) { setStatus("error"); return; }
      setStatus("success");
      refresh();
    } catch {
      setStatus("error");
    }
  }
  return { status, submit };
}

function StatusLine({ status, t }: { status: string; t: Translator }) {
  return (
    <>
      {status === "error" && <p role="alert" className={styles.error}>{t("form.error")}</p>}
      <p role="status" className={styles.hint}>{status === "success" ? t("form.success") : ""}</p>
    </>
  );
}

function SourceForm({ caseId, locale, evidenceItems, t, refresh }: { caseId: string; locale: string; evidenceItems: Array<{ id: string; title: string }>; t: Translator; refresh: () => void }) {
  const [kind, setKind] = useState<(typeof SOURCE_KINDS)[number]>("DOCUMENT");
  const [title, setTitle] = useState("");
  const [origin, setOrigin] = useState("");
  const [citation, setCitation] = useState("");
  const [legalFramework, setLegalFramework] = useState("");
  const [evidenceItemId, setEvidenceItemId] = useState("");
  const [visibility, setVisibility] = useState("CASE");
  const saver = useSaver(`/api/cases/${caseId}/sources`, () => ({
    kind, title, origin, citation, legalFramework, visibility, language: locale,
    evidenceItemId: evidenceItemId || null,
  }), refresh);
  return (
    <form onSubmit={saver.submit} aria-label={t("form.sourceTitle")}>
      <h3>{t("form.sourceTitle")}</h3>
      <fieldset disabled={saver.status === "busy"}>
        <div className={styles.formRow}>
          <label htmlFor="claim-source-kind">{t("form.sourceKind")}</label>
          <select id="claim-source-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            {SOURCE_KINDS.map((value) => <option key={value} value={value}>{t(`sourceKind.${value}`)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-source-title">{t("form.sourceTitleLabel")}</label>
          <input id="claim-source-title" required maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-source-origin">{t("form.origin")}</label>
          <input id="claim-source-origin" maxLength={500} value={origin} onChange={(event) => setOrigin(event.target.value)} />
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-source-citation">{t("form.citation")}</label>
          <input id="claim-source-citation" required={kind === "STATUTE"} maxLength={500} value={citation} onChange={(event) => setCitation(event.target.value)} />
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-source-framework">{t("form.legalFramework")}</label>
          <input id="claim-source-framework" maxLength={300} value={legalFramework} onChange={(event) => setLegalFramework(event.target.value)} />
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-source-evidence">{t("form.evidenceItem")}</label>
          <select id="claim-source-evidence" required={kind === "EVIDENCE_ITEM"} value={evidenceItemId} onChange={(event) => setEvidenceItemId(event.target.value)}>
            <option value="">{t("form.evidenceNone")}</option>
            {evidenceItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-source-visibility">{t("form.visibility")}</label>
          <select id="claim-source-visibility" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            <option value="CASE">{t("visibility.CASE")}</option>
            <option value="RESTRICTED">{t("visibility.RESTRICTED")}</option>
            <option value="REDACTED">{t("visibility.REDACTED")}</option>
          </select>
        </div>
        <button type="submit">{saver.status === "busy" ? t("form.submitting") : t("form.saveSource")}</button>
      </fieldset>
      <StatusLine status={saver.status} t={t} />
    </form>
  );
}

function ClaimForm({ caseId, locale, t, refresh }: { caseId: string; locale: string; t: Translator; refresh: () => void }) {
  const [claimType, setClaimType] = useState<(typeof CLAIM_TYPES)[number]>("FACTUAL");
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<(typeof CONFIDENCE)[number]>("UNKNOWN");
  const [confidenceRationale, setConfidenceRationale] = useState("");
  const saver = useSaver(`/api/cases/${caseId}/claims`, () => ({ claimType, text, confidence, confidenceRationale, locale }), refresh);
  return (
    <form onSubmit={saver.submit} aria-label={t("form.claimTitle")}>
      <h3>{t("form.claimTitle")}</h3>
      <fieldset disabled={saver.status === "busy"}>
        <div className={styles.formRow}>
          <label htmlFor="claim-type">{t("form.claimType")}</label>
          <select id="claim-type" value={claimType} onChange={(event) => setClaimType(event.target.value as typeof claimType)}>
            {CLAIM_TYPES.map((value) => <option key={value} value={value}>{t(`type.${value}`)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-text">{t("form.claimText")}</label>
          <textarea id="claim-text" required rows={3} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} />
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-confidence">{t("form.confidence")}</label>
          <select id="claim-confidence" value={confidence} onChange={(event) => setConfidence(event.target.value as typeof confidence)}>
            {CONFIDENCE.map((value) => <option key={value} value={value}>{t(`confidence.${value}`)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="claim-rationale">{t("form.rationale")}</label>
          <textarea id="claim-rationale" required={confidence === "UNKNOWN" || confidence === "DISPUTED"} rows={2} maxLength={4000} value={confidenceRationale} onChange={(event) => setConfidenceRationale(event.target.value)} />
          <p className={styles.hint}>{t("form.rationaleHint")}</p>
        </div>
        <button type="submit">{saver.status === "busy" ? t("form.submitting") : t("form.saveClaim")}</button>
      </fieldset>
      <StatusLine status={saver.status} t={t} />
    </form>
  );
}

function useListedId(options: Array<{ id: string }>) {
  const [picked, setPicked] = useState<string | null>(null);
  const fallback = options[0]?.id ?? "";
  const id = picked && options.some((option) => option.id === picked) ? picked : fallback;
  return [id, setPicked] as const;
}

function LinkForm({ caseId, sources, claims, t, refresh }: { caseId: string; sources: Array<{ id: string; title: string }>; claims: Array<{ id: string; text: string }>; t: Translator; refresh: () => void }) {
  const [claimId, setClaimId] = useListedId(claims);
  const [sourceId, setSourceId] = useListedId(sources);
  const [predicate, setPredicate] = useState<(typeof LINK_PREDICATES)[number]>("ORIGINATES_FROM");
  const [excerpt, setExcerpt] = useState("");
  const ready = Boolean(claimId && sourceId);
  const saver = useSaver(`/api/cases/${caseId}/claims/${claimId}/evidence-links`, () => ({ sourceId, predicate, excerpt }), refresh);
  return (
    <form onSubmit={saver.submit} aria-label={t("form.linkTitle")}>
      <h3>{t("form.linkTitle")}</h3>
      <fieldset disabled={saver.status === "busy" || !ready}>
        <div className={styles.formRow}>
          <label htmlFor="link-claim">{t("form.linkClaim")}</label>
          <select id="link-claim" required value={claimId} onChange={(event) => setClaimId(event.target.value)}>
            {claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.text.slice(0, 80)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="link-source">{t("form.linkSource")}</label>
          <select id="link-source" required value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="link-predicate">{t("form.linkPredicate")}</label>
          <select id="link-predicate" value={predicate} onChange={(event) => setPredicate(event.target.value as typeof predicate)}>
            {LINK_PREDICATES.map((value) => <option key={value} value={value}>{t(`linkPredicate.${value}`)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="link-excerpt">{t("form.excerpt")}</label>
          <textarea id="link-excerpt" required rows={3} maxLength={8000} value={excerpt} onChange={(event) => setExcerpt(event.target.value)} aria-describedby="link-excerpt-hint" />
          <p id="link-excerpt-hint" className={styles.hint}>{t("form.excerptHint")}</p>
        </div>
        <button type="submit">{saver.status === "busy" ? t("form.submitting") : t("form.saveLink")}</button>
      </fieldset>
      <StatusLine status={saver.status} t={t} />
    </form>
  );
}

function RelationshipForm({ caseId, claims, t, refresh }: { caseId: string; claims: Array<{ id: string; text: string }>; t: Translator; refresh: () => void }) {
  const [fromClaimId, setFromClaimId] = useListedId(claims);
  const [toClaimId, setToClaimId] = useListedId([...claims].reverse());
  const [predicate, setPredicate] = useState<(typeof RELATION_PREDICATES)[number]>("CONTRADICTS");
  const [rationale, setRationale] = useState("");
  const saver = useSaver(`/api/cases/${caseId}/claim-relationships`, () => ({ fromClaimId, toClaimId, predicate, rationale }), refresh);
  return (
    <form onSubmit={saver.submit} aria-label={t("form.relationshipTitle")}>
      <h3>{t("form.relationshipTitle")}</h3>
      <fieldset disabled={saver.status === "busy" || claims.length < 2}>
        <div className={styles.formRow}>
          <label htmlFor="rel-from">{t("form.fromClaim")}</label>
          <select id="rel-from" required value={fromClaimId} onChange={(event) => setFromClaimId(event.target.value)}>
            {claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.text.slice(0, 80)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="rel-to">{t("form.toClaim")}</label>
          <select id="rel-to" required value={toClaimId} onChange={(event) => setToClaimId(event.target.value)}>
            {claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.text.slice(0, 80)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="rel-predicate">{t("form.relationPredicate")}</label>
          <select id="rel-predicate" value={predicate} onChange={(event) => setPredicate(event.target.value as typeof predicate)}>
            {RELATION_PREDICATES.map((value) => <option key={value} value={value}>{t(`relationPredicate.${value}`)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="rel-rationale">{t("form.rationale")}</label>
          <textarea id="rel-rationale" rows={2} maxLength={2000} value={rationale} onChange={(event) => setRationale(event.target.value)} />
        </div>
        <button type="submit">{saver.status === "busy" ? t("form.submitting") : t("form.saveRelationship")}</button>
      </fieldset>
      <StatusLine status={saver.status} t={t} />
    </form>
  );
}

function ReviewForm({ caseId, claims, t, refresh }: { caseId: string; claims: Array<{ id: string; text: string }>; t: Translator; refresh: () => void }) {
  const [claimId, setClaimId] = useListedId(claims);
  const [action, setAction] = useState<"NOTED" | "EDITED">("NOTED");
  const [rationale, setRationale] = useState("");
  const saver = useSaver(`/api/cases/${caseId}/reviews`, () => ({ claimId: claimId || null, action, rationale }), refresh);
  return (
    <form onSubmit={saver.submit} aria-label={t("form.reviewTitle")}>
      <h3>{t("form.reviewTitle")}</h3>
      <fieldset disabled={saver.status === "busy"}>
        <div className={styles.formRow}>
          <label htmlFor="review-claim">{t("form.linkClaim")}</label>
          <select id="review-claim" value={claimId} onChange={(event) => setClaimId(event.target.value)}>
            {claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.text.slice(0, 80)}</option>)}
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="review-action">{t("form.reviewAction")}</label>
          <select id="review-action" value={action} onChange={(event) => setAction(event.target.value as typeof action)}>
            <option value="NOTED">{t("form.reviewNoted")}</option>
            <option value="EDITED">{t("form.reviewEdited")}</option>
          </select>
        </div>
        <div className={styles.formRow}>
          <label htmlFor="review-rationale">{t("form.rationale")}</label>
          <textarea id="review-rationale" required={action === "EDITED"} rows={2} maxLength={4000} value={rationale} onChange={(event) => setRationale(event.target.value)} />
        </div>
        <button type="submit">{saver.status === "busy" ? t("form.submitting") : t("form.saveReview")}</button>
      </fieldset>
      <StatusLine status={saver.status} t={t} />
    </form>
  );
}
