import type { ClaimTypeName, ClaimsView, PresentedClaim } from "../../../../domain/claimPresentation";
import styles from "./workspace.module.css";

export interface ClaimsCopy {
  title: string;
  description: string;
  empty: string;
  needsEvidenceHeading: string;
  needsEvidenceNotice: string;
  why: string;
  provenanceTitle: string;
  excerptLabel: string;
  sourceLabel: string;
  recordedBy: string;
  linkRecordedBy: string;
  redacted: string;
  citation: string;
  framework: string;
  evidenceItem: string;
  confidenceLabel: string;
  statusLabel: string;
  typeLabel: string;
  impactNotice: string;
  relationshipsTitle: string;
  noRelationships: string;
  role: { complainant: string; respondent: string; manager: string };
  type: Record<ClaimTypeName, string>;
  confidence: Record<string, string>;
  status: Record<string, string>;
  linkPredicate: Record<string, string>;
  relationPredicate: Record<string, string>;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

function ClaimBody({
  claim,
  copy,
  locale,
  authorName,
  formatWhen,
  complainantId,
  respondentId,
}: {
  claim: PresentedClaim;
  copy: ClaimsCopy;
  locale: string;
  authorName: (id: string) => string;
  formatWhen: (iso: string) => string;
  complainantId: string;
  respondentId: string;
}) {
  return (
    <li
      data-claim-id={claim.id}
      data-claim-rendered={claim.rendered ? "true" : "false"}
      data-claim-type={claim.claimType}
      data-rendered-status={claim.renderedStatus}
      data-shown-as-fact={claim.shownAsFactClaim ? "true" : "false"}
      data-scored-as-fact={claim.scoredAsFact ? "true" : "false"}
      className={`${styles.claim} ${styles.originRecord}`}
      data-origin="CASE_MANAGER"
    >
      <span className={styles.originLabel}>{copy.role.manager}</span>
      <p className={styles.claimMeta}>
        <span className={styles.claimType}>{copy.type[claim.claimType]}</span>
        {" · "}
        <span>{copy.statusLabel}: {copy.status[claim.renderedStatus]}</span>
        {" · "}
        <span>{copy.confidenceLabel}: {copy.confidence[claim.displayedConfidence]}</span>
      </p>
      {claim.claimType === "IMPACT_STATEMENT" && <p className={styles.hint}>{copy.impactNotice}</p>}
      {claim.rendered ? (
        <>
          <p className={styles.recordText} lang={claim.locale}>{claim.text}</p>
          <p className={styles.hint}>{fill(copy.recordedBy, { name: authorName(claim.createdById), when: formatWhen(claim.createdAt) })}</p>
          <details className={styles.provenance}>
            <summary>{copy.why}</summary>
            <h3>{copy.provenanceTitle}</h3>
            <ul>
              {claim.links.map((link) => (
                <li key={link.id} data-provenance-link={link.id} className={link.evidenceSubmittedById ? styles.originRecord : undefined} data-origin={link.evidenceSubmittedById === complainantId ? "COMPLAINANT" : link.evidenceSubmittedById === respondentId ? "RESPONDENT" : undefined}>
                  {link.evidenceSubmittedById === complainantId && <span className={styles.originLabel}>{copy.role.complainant}</span>}
                  {link.evidenceSubmittedById === respondentId && <span className={styles.originLabel}>{copy.role.respondent}</span>}
                  <p><strong>{copy.sourceLabel}:</strong> {link.sourceTitle}</p>
                  {link.citation && <p>{fill(copy.citation, { citation: link.citation })}</p>}
                  {link.legalFramework && <p>{fill(copy.framework, { name: link.legalFramework })}</p>}
                  {link.evidenceTitle && <p>{fill(copy.evidenceItem, { title: link.evidenceTitle })}</p>}
                  <p>{copy.linkPredicate[link.predicate]}</p>
                  <p>
                    <strong>{copy.excerptLabel}:</strong>{" "}
                    {link.redacted || !link.excerpt ? copy.redacted : <q lang={link.language || claim.locale}>{link.excerpt}</q>}
                  </p>
                  <p className={styles.hint}>{fill(copy.linkRecordedBy, { name: authorName(link.createdById), when: formatWhen(link.createdAt) })}</p>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className={styles.hint}>{copy.needsEvidenceNotice}</p>
      )}
    </li>
  );
}

export function ClaimsList({
  locale,
  view,
  authors,
  copy,
  complainantId,
  respondentId,
}: {
  locale: string;
  view: ClaimsView;
  authors: Array<{ id: string; displayName: string }>;
  copy: ClaimsCopy;
  complainantId: string;
  respondentId: string;
}) {
  const names = new Map(authors.map((author) => [author.id, author.displayName]));
  const authorName = (id: string) => names.get(id) ?? id;
  const formatWhen = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const claimText = new Map([...view.rendered, ...view.needsEvidence].map((claim) => [claim.id, claim.text]));

  return (
    <section aria-labelledby="claims-heading" className={`${styles.section} ${styles.tile}`} data-claims-panel data-claims-locale={locale}>
      <h2 id="claims-heading">{copy.title}</h2>
      <p>{copy.description}</p>
      {view.rendered.length === 0 ? (
        <p>{copy.empty}</p>
      ) : (
        <ul data-rendered-claims>
          {view.rendered.map((claim) => (
            <ClaimBody key={claim.id} claim={claim} copy={copy} locale={locale} authorName={authorName} formatWhen={formatWhen} complainantId={complainantId} respondentId={respondentId} />
          ))}
        </ul>
      )}
      {view.needsEvidence.length > 0 && (
        <div data-needs-evidence>
          <h3>{copy.needsEvidenceHeading}</h3>
          <ul>
            {view.needsEvidence.map((claim) => (
              <ClaimBody key={claim.id} claim={claim} copy={copy} locale={locale} authorName={authorName} formatWhen={formatWhen} complainantId={complainantId} respondentId={respondentId} />
            ))}
          </ul>
        </div>
      )}
      <h3>{copy.relationshipsTitle}</h3>
      {view.relationships.length === 0 ? (
        <p className={styles.hint}>{copy.noRelationships}</p>
      ) : (
        <ul>
          {view.relationships.map((row) => (
            <li key={row.id} data-relationship-id={row.id}>
              <span lang={locale}>{claimText.get(row.fromClaimId)}</span>
              {" "}
              {copy.relationPredicate[row.predicate]}
              {" "}
              <span lang={locale}>{claimText.get(row.toClaimId)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
