'use client';

import { useState } from 'react';
import LegriproCompliance from '../components/LegriproCompliance';
import NeutralArbiter from '../components/NeutralArbiter';
import PatternIntelligence from '../components/PatternIntelligence';

const VIEWS = {
  disputes: 'Active disputes',
  compliance: 'Case safeguards',
  analytics: 'Portfolio snapshot',
  settings: 'Workspace settings',
};

export default function Home() {
  const [view, setView] = useState('disputes');

  return (
    <>
      <div className="demo-banner" role="note">
        Demonstration workspace — fictional case and portfolio data. No resolution, statutory assessment, or message is sent outside this page.
      </div>
      <header>
        <div className="brand-lockup">
          <span className="logo-icon" aria-hidden="true" />
          <h1 className="logo">Aequitas</h1>
          <span className="product-tag">resolution workspace</span>
        </div>
        <nav className="header-nav" aria-label="Workspace sections">
          {Object.entries(VIEWS).map(([key, label]) => (
            <button key={key} type="button" className="nav-button" aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="main-layout">
        {view === 'disputes' && <><LegriproCompliance /><NeutralArbiter /><PatternIntelligence /></>}
        {view === 'compliance' && <ComplianceView />}
        {view === 'analytics' && <AnalyticsView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </>
  );
}

function ComplianceView() {
  return <section className="workspace-page panel"><div className="panel-header"><h2 className="panel-title">Case safeguards</h2><p className="panel-subtitle">Evidence and governance checks for case #DS-8922-A</p></div><div className="panel-content prose"><h3>Required before a decision</h3><ul><li>Both parties receive the same proposal and its rationale.</li><li>Consent, objections, and amendments are time-stamped in the case record.</li><li>A human reviewer can intervene before closure.</li></ul><h3>Current record</h3><dl className="record-list"><dt>Decision authority</dt><dd>Human case manager — not delegated</dd><dt>Conflict check</dt><dd>Pending reviewer confirmation</dd><dt>Legal context</dt><dd>Informational guidance only; not a legal determination</dd></dl></div></section>;
}

function AnalyticsView() {
  return <section className="workspace-page panel"><div className="panel-header"><h2 className="panel-title">Portfolio snapshot</h2><p className="panel-subtitle">Illustrative, fixed dataset · refreshed 14 Aug 2026, 09:00 UTC</p></div><div className="panel-content prose"><h3>What this view can support</h3><p>Use aggregate trends to decide where to investigate. Do not use these figures to auto-resolve cases or to make claims about legal compliance or bias.</p><div className="metric-row"><div><strong>1,428</strong><span>illustrative complaints</span></div><div><strong>74.0%</strong><span>illustrative mutual-agreement rate</span></div><div><strong>0</strong><span>live integrations</span></div></div><p className="notice">Dataset provenance: seeded demonstration fixture; not customer, retailer, or regulatory data.</p></div></section>;
}

function SettingsView() {
  return <section className="workspace-page panel"><div className="panel-header"><h2 className="panel-title">Workspace settings</h2><p className="panel-subtitle">Prototype controls</p></div><div className="panel-content prose"><h3>Production controls to configure</h3><ul><li>Role-based access and party identity verification</li><li>Retention, export, and deletion policy</li><li>Reviewer assignment and conflict-of-interest declarations</li><li>Auditable model and policy versioning</li></ul><p className="notice">These controls are displayed as requirements only. This prototype does not persist settings.</p></div></section>;
}
