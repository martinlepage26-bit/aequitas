'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_CASE_ID } from '../lib/constants';
import { JURISDICTION, LEGAL_FRAMEWORK_CAVEAT, PROVISIONS, STATUTE } from '../lib/legalFramework';

const CASE_URL = `/api/cases/${encodeURIComponent(DEFAULT_CASE_ID)}`;

const STATUS_LABEL = {
  party_consent: 'Open for party review',
  manager_review: 'Awaiting case-manager review',
  agreed: 'Agreed and closed',
  declined: 'Declined and closed',
};

export default function LegriproCompliance({ caseId = DEFAULT_CASE_ID, caseCategory = 'Consumer goods' }) {
  const [legal, setLegal] = useState({ status: 'loading', results: [] });
  const [caseState, setCaseState] = useState(null);
  const [caseError, setCaseError] = useState(null);

  useEffect(() => {
    let active = true;
    fetch('/api/legal-context')
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => active && setLegal(response.ok ? { status: 'ready', ...body } : { status: 'unavailable', ...body }))
      .catch(() => active && setLegal({ status: 'unavailable', message: 'The legal research service could not be reached.' }));
    fetch(CASE_URL)
      .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
      .then(({ ok, body }) => {
        if (!active) return;
        if (ok) setCaseState(body);
        else setCaseError(body.message || 'The case record could not be loaded.');
      })
      .catch(() => active && setCaseError('The case record could not be reached.'));
    return () => { active = false; };
  }, []);

  return (
    <section className="panel">
      <div className="panel-header"><h2 className="panel-title">Case record</h2><p className="panel-subtitle">{caseId} · {caseCategory}</p></div>
      <div className="panel-content">
        <div className="case-status"><span className="status-dot" aria-hidden="true" /> {caseError ? caseError : caseState ? (STATUS_LABEL[caseState.status] || caseState.status) : 'Loading case status…'}</div>
        {caseState && typeof caseState.claimValue === 'number' && <div className="stat-card"><h3>Claim value</h3><div className="value">${caseState.claimValue.toFixed(2)}</div><p>Consumer: {caseState.consumerStance}</p><p>Retailer: {caseState.retailerStance}</p></div>}
        <section className="legal-context" aria-live="polite"><h3>Legal research context</h3><p className="source-label">Retrieved through LegiPro API · research support only</p>
          {legal.status === 'loading' && <p>Checking the configured research source…</p>}
          {legal.status === 'unavailable' && <p className="notice">{legal.message || 'No LegiPro API connection is configured. Legal conclusions remain unavailable.'}</p>}
          {legal.status === 'ready' && <>
            {legal.results?.length ? <ul className="source-list">{legal.results.map((result) => <li key={result.id}><strong>{result.title}</strong><span>{result.citation || result.snippet}</span>{result.claim_boundary && <em>Boundary: {result.claim_boundary}</em>}</li>)}</ul> : <p className="notice">No source was returned for this query. Do not infer entitlement.</p>}
            <p className="notice">{legal.disclaimer}</p>
          </>}
        </section>
        <section className="legal-context"><h3>Governing framework — {JURISDICTION.label}</h3>
          <p className="source-label">{STATUTE.name} ({STATUTE.citation}) · <a href={STATUTE.sourceUrl} target="_blank" rel="noreferrer">{STATUTE.sourceName}</a></p>
          <ul className="source-list">{PROVISIONS.map((p) => (
            <li key={p.section}>
              <strong>{p.section}{!p.inForce && ` — not in force until ${p.effectiveDate}`}</strong>
              <span>{p.summary}</span>
            </li>
          ))}</ul>
          <p className="notice">{LEGAL_FRAMEWORK_CAVEAT} Consumer protection is provincial in Canada — this reference applies to {JURISDICTION.label} only. Complaints can be filed with the <a href={JURISDICTION.regulator.url} target="_blank" rel="noreferrer">{JURISDICTION.regulator.name}</a>.</p>
        </section>
        <section className="audit-mini"><h3>Case controls</h3><ul>
          <li>Party identity: unverified — role is self-selected in this prototype, not authenticated</li>
          <li>Conflicts check: not implemented — awaiting a real case-manager assignment process</li>
          <li>Decision record: {caseState?.status === 'agreed' ? `created, audit chain ${caseState.auditChainVerified ? 'verified' : 'FAILED VERIFICATION'}` : 'not yet created'}</li>
          <li>Fulfillment: {caseState?.fulfillment ? 'logged (simulated — no external system connected)' : 'not applicable yet'}</li>
        </ul></section>
      </div>
    </section>
  );
}
