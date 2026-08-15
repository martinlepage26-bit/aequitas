'use client';
import { useEffect, useState } from 'react';
import { DEFAULT_CASE_ID } from '../lib/constants';
import { PARTICIPATION_DISCLOSURE } from '../lib/legalFramework';

const ROLES = { consumer: 'Consumer', retailer: 'Retailer', manager: 'Case manager' };
const CASE_URL = `/api/cases/${encodeURIComponent(DEFAULT_CASE_ID)}`;

function stepClass(status, step) {
  if (status === 'agreed' || status === 'declined') return 'step-done';
  if (status === 'manager_review') return step <= 2 ? 'step-done' : 'step-current';
  return step <= 1 ? 'step-done' : step === 2 ? 'step-current' : undefined;
}

export default function NeutralArbiter() {
  const [role, setRole] = useState('retailer');
  const [response, setResponse] = useState('');
  const [caseState, setCaseState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const refresh = () =>
    fetch(CASE_URL)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.message || 'Failed to load the case record.');
        setCaseState(body);
        setLoadError(null);
      })
      .catch((error) => setLoadError(error.message));

  useEffect(() => {
    refresh();
  }, []);

  if (loadError) {
    return (
      <section className="panel arbiter-panel">
        <div className="panel-header"><h2 className="panel-title">Resolution workspace</h2></div>
        <div className="panel-content"><p className="notice" role="alert">{loadError}</p></div>
      </section>
    );
  }
  if (!caseState) {
    return (
      <section className="panel arbiter-panel">
        <div className="panel-header"><h2 className="panel-title">Resolution workspace</h2></div>
        <div className="panel-content"><p>Loading the case record…</p></div>
      </section>
    );
  }

  const { status, consents, messages, recommendation, fulfillment, auditChainVerified } = caseState;
  const roleConsent = role === 'manager' ? consents.managerConfirmed : consents[role];
  const canRecordAgreement = status === 'agreed';

  const runAction = async (url, body) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const responseBody = await res.json();
      if (!res.ok) throw new Error(responseBody.message || 'The action was rejected by the case record.');
      setCaseState(responseBody);
      return true;
    } catch (error) {
      setActionError(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitResponse = (event) => {
    event.preventDefault();
    const text = response.trim();
    if (!text) return;
    runAction(CASE_URL + '/messages', { role, text }).then((ok) => ok && setResponse(''));
  };

  const generateRecommendation = () => {
    runAction(CASE_URL + '/recommendation', { role: 'manager' }).then((ok) => ok && setAcknowledged(false));
  };

  const toggleConsent = () => {
    if (role === 'manager') {
      runAction(CASE_URL + '/consent', { role, action: roleConsent ? 'withdraw' : 'grant' });
      return;
    }
    runAction(CASE_URL + '/consent', {
      role,
      action: roleConsent ? 'withdraw' : 'grant',
      acknowledgeVoluntary: roleConsent ? undefined : acknowledged,
    }).then((ok) => ok && setAcknowledged(false));
  };

  return <section className="panel arbiter-panel">
    <div className="panel-header arbiter-header"><div><h2 className="panel-title">Resolution workspace</h2><p className="panel-subtitle">A recommendation needs both parties’ consent and case-manager review.</p></div><label className="role-picker">Viewing as<select value={role} onChange={(event) => { setRole(event.target.value); setAcknowledged(false); }}>{Object.entries(ROLES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label></div>
    <div className="panel-content"><div className="case-steps" aria-label="Case progress"><span className={stepClass(status, 1)}>1 Evidence shared</span><span className={stepClass(status, 2)}>2 Party review</span><span className={stepClass(status, 3)}>3 Agreement record</span></div><div className="chat-area" aria-live="polite">{messages.map((message) => <article className="message system" key={message.id}><div className="message-bubble"><strong>{ROLES[message.authorRole] || message.authorRole}</strong><br />{message.text}</div></article>)}</div>
      {actionError && <p className="notice" role="alert">{actionError}</p>}

      {!recommendation && (
        <article className="proposal-card">
          <div className="proposal-title">No recommendation yet</div>
          <p>No resolution recommendation has been drafted for this case. {role === 'manager' ? 'Generate one to start party review.' : 'Waiting on the case manager.'}</p>
          {role === 'manager' && <button className="btn btn-primary" type="button" onClick={generateRecommendation} disabled={busy}>Generate AI recommendation</button>}
        </article>
      )}

      {recommendation && <article className="proposal-card">
        <div className="proposal-title">Draft resolution proposal</div>
        <p>{recommendation.proposalText}</p>
        <div className="proposal-rationale"><h3>Why this is proposed</h3><ul>{recommendation.rationale.map((point, i) => <li key={i}>{point}</li>)}</ul></div>
        <p className="notice">{recommendation.limits}</p>
        <p className="source-label">Drafted by {recommendation.model} · a case-manager-triggered draft, not a decision</p>

        <div className="consent-grid"><div><span>Consumer consent</span><strong>{consents.consumer ? 'Recorded' : 'Awaiting response'}</strong></div><div><span>Retailer consent</span><strong>{consents.retailer ? 'Recorded' : 'Awaiting response'}</strong></div><div><span>Case-manager review</span><strong>{consents.managerConfirmed ? 'Confirmed' : 'Required'}</strong></div></div>

        {(role === 'consumer' || role === 'retailer') && !roleConsent && (
          <label className="input-help" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', margin: '0.75rem 0' }}>
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>{PARTICIPATION_DISCLOSURE}</span>
          </label>
        )}

        <button className="btn btn-primary" type="button" onClick={toggleConsent} disabled={busy || ((role === 'consumer' || role === 'retailer') && !roleConsent && !acknowledged)}>{roleConsent ? `Withdraw ${role === 'manager' ? 'review' : 'consent'}` : role === 'manager' ? 'Confirm review' : 'Record consent'}</button>
        {role === 'manager' && <>
          {' '}<button className="btn btn-outline" type="button" onClick={generateRecommendation} disabled={busy}>Regenerate recommendation</button>
          <p className="input-help">Regenerating replaces this proposal and resets both parties&apos; consent.</p>
        </>}

        {canRecordAgreement && <p className="agreement-ready" role="status">
          {auditChainVerified
            ? 'All approvals are recorded in the case record, with a verified audit trail.'
            : 'Audit-trail verification failed. Do not rely on this agreement record.'}
          {fulfillment && <> {fulfillment.note} {fulfillment.proposedAction && <>Recorded next step: {fulfillment.proposedAction}</>}</>}
        </p>}
      </article>}
    </div>
    <div className="chat-input-area"><form className="chat-input-wrapper" onSubmit={submitResponse}><label className="visually-hidden" htmlFor="case-response">Add a response to the case record</label><input id="case-response" className="chat-input" value={response} onChange={(event) => setResponse(event.target.value)} placeholder={`Add a response as ${ROLES[role]}…`} disabled={busy} /><button type="submit" className="btn btn-primary" disabled={busy}>Add to case record</button></form><p className="input-help">Responses are written to this case&apos;s persistent record and audit trail. Role is self-selected in this prototype — there is no identity verification yet.</p></div>
  </section>;
}
