'use client';
import { useState } from 'react';

const SNAPSHOT = { complaints: 1428, agreementRate: '74.0%', timestamp: '14 Aug 2026, 09:00 UTC' };

export default function PatternIntelligence() {
  const [showProvenance, setShowProvenance] = useState(false);

  return (
    <section className="panel">
      <div className="panel-header"><h2 className="panel-title">Portfolio snapshot</h2><p className="panel-subtitle">Illustrative fixture · {SNAPSHOT.timestamp}</p></div>
      <div className="panel-content">
        <div className="insight-item"><div className="insight-header"><h3>Widget A pattern for review</h3><span className="badge badge-warning">Review queue</span></div><p>{SNAPSHOT.complaints.toLocaleString()} fictional reports are grouped by the same product issue. This is a seeded sample, not a live alert.</p><button type="button" className="text-button" aria-expanded={showProvenance} onClick={() => setShowProvenance(!showProvenance)}>{showProvenance ? 'Hide data provenance' : 'View data provenance'}</button>{showProvenance && <p className="notice">Dataset provenance: seeded demonstration fixture, generated for this prototype. Not customer, retailer, or regulatory data, and not connected to any live case queue.</p>}</div>
        <div className="insight-item"><div className="insight-header"><h3>Resolution outcomes</h3><span className="badge badge-neutral">Sample only</span></div><div className="metric-pair"><div><strong>{SNAPSHOT.agreementRate}</strong><span>mutual agreement</span></div><div><strong>0</strong><span>automated decisions</span></div></div><p>Outcome rates describe the fixture only. They are not a fairness, compliance, or savings finding.</p></div>
        <div className="insight-item"><h3>Governance signal</h3><p>Before any trend informs operations, validate its source, population, missing data, and impact across protected groups with a named reviewer.</p><span className="badge badge-neutral">No assessment recorded</span></div>
      </div>
    </section>
  );
}
