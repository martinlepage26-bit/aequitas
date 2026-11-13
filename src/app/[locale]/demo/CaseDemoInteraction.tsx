"use client";

import { useState } from "react";
import styles from "./interaction.module.css";

type PartyId = "complainant" | "respondent";
type Choice = "consent" | "decline" | "person";

type PartyView = {
  label: string;
  position: string;
  evidence: string;
  proposal: string;
};

type Copy = {
  title: string;
  description: string;
  roleLabel: string;
  roleNotice: string;
  positionLabel: string;
  evidenceTitle: string;
  evidenceLabel: string;
  proposalTitle: string;
  proposalDescription: string;
  choiceTitle: string;
  choiceHint: string;
  consent: string;
  decline: string;
  askPerson: string;
  reset: string;
  statusLabel: string;
  progressTitle: string;
  waiting: string;
  consented: string;
  handedOff: string;
  status: {
    initial: string;
    accepted: string;
    completed: string;
    handoff: string;
  };
};

export default function CaseDemoInteraction({
  parties,
  copy,
}: {
  parties: Record<PartyId, PartyView>;
  copy: Copy;
}) {
  const [activeParty, setActiveParty] = useState<PartyId>("complainant");
  const [choices, setChoices] = useState<Record<PartyId, Choice | null>>({
    complainant: null,
    respondent: null,
  });

  const stopped = Object.values(choices).some((choice) => choice === "decline" || choice === "person");
  const bothConsented = choices.complainant === "consent" && choices.respondent === "consent";
  const ownChoice = choices[activeParty];
  const status = stopped
    ? copy.status.handoff
    : bothConsented
      ? copy.status.completed
      : ownChoice === "consent"
        ? copy.status.accepted
        : copy.status.initial;
  const party = parties[activeParty];
  const actionsDisabled = stopped || bothConsented || ownChoice !== null;

  function choose(choice: Choice) {
    if (actionsDisabled) return;
    setChoices((current) => ({ ...current, [activeParty]: choice }));
  }

  function reset() {
    setActiveParty("complainant");
    setChoices({ complainant: null, respondent: null });
  }

  return (
    <section className={styles.interaction} aria-labelledby="case-demo-interaction-title" data-testid="case-demo-interaction">
      <header className={styles.interactionHeader}>
        <div>
          <p className={styles.kicker}>{copy.roleLabel}</p>
          <h2 id="case-demo-interaction-title">{copy.title}</h2>
          <p className={styles.description}>{copy.description}</p>
        </div>
        <button className={styles.reset} type="button" onClick={reset}>{copy.reset}</button>
      </header>

      <div className={styles.roleSwitch} role="group" aria-label={copy.roleLabel}>
        {(["complainant", "respondent"] as const).map((role) => (
          <button
            key={role}
            className={styles.roleOption}
            type="button"
            aria-pressed={activeParty === role}
            onClick={() => setActiveParty(role)}
          >
            <span>{parties[role].label}</span>
            <span className={styles.roleHint} aria-hidden="true">{activeParty === role ? "●" : "○"}</span>
          </button>
        ))}
      </div>

      <div className={styles.progress} aria-label={copy.progressTitle}>
        <div className={styles.progressHeading}><span>{copy.progressTitle}</span><span>{bothConsented ? "2 / 2" : `${Object.values(choices).filter(Boolean).length} / 2`}</span></div>
        <div className={styles.progressTrack} aria-hidden="true"><span className={bothConsented ? styles.progressComplete : stopped ? styles.progressHandoff : ""} style={{ width: `${stopped ? 100 : Object.values(choices).filter(Boolean).length * 50}%` }} /></div>
        <div className={styles.partyProgress}>
          {(["complainant", "respondent"] as const).map(role => {
            const choice = choices[role];
            const label = choice === "consent" ? copy.consented : choice ? copy.handedOff : copy.waiting;
            return <div key={role} className={styles.partyProgressItem} data-state={choice === "consent" ? "consented" : choice ? "handoff" : activeParty === role ? "active" : "waiting"}>
              <span aria-hidden="true">{choice === "consent" ? "✓" : choice ? "↗" : activeParty === role ? "●" : "○"}</span>
              <span>{parties[role].label}</span><small>{label}</small>
            </div>;
          })}
        </div>
      </div>

      <p className={styles.roleNotice}>{copy.roleNotice}</p>

      <article key={activeParty} className={styles.partyRecord} aria-labelledby="case-demo-party-title">
        <header className={styles.recordHeader}>
          <h3 id="case-demo-party-title">{party.label}</h3>
        </header>
        <div className={styles.recordBody}>
          <section className={styles.recordField} aria-labelledby="case-demo-position-title">
            <h4 id="case-demo-position-title">{copy.positionLabel}</h4>
            <blockquote className={styles.positionQuote}>{party.position}</blockquote>
          </section>
          <section className={styles.recordField} aria-labelledby="case-demo-evidence-title">
            <h4 id="case-demo-evidence-title">{copy.evidenceTitle}</h4>
            <p className={styles.sourceLabel}>{copy.evidenceLabel}</p>
            <blockquote className={styles.evidenceQuote}>{party.evidence}</blockquote>
          </section>
          <section className={`${styles.recordField} ${styles.proposalField}`} aria-labelledby="case-demo-proposal-title">
            <h4 id="case-demo-proposal-title">{copy.proposalTitle}</h4>
            <p className={styles.proposalDescription}>{copy.proposalDescription}</p>
            <p className={styles.proposalText}>{party.proposal}</p>
            <p className={styles.citationNote}>{party.evidence}</p>
          </section>
        </div>

        <div className={styles.choiceArea}>
          <div className={styles.choiceHeading}>
            <h4>{copy.choiceTitle}</h4>
            <p>{copy.choiceHint}</p>
          </div>
          <div className={styles.choiceActions} role="group" aria-label={copy.choiceTitle}>
            <button type="button" onClick={() => choose("consent")} disabled={actionsDisabled}>{copy.consent}</button>
            <button className={styles.secondaryChoice} type="button" onClick={() => choose("decline")} disabled={actionsDisabled}>{copy.decline}</button>
            <button className={styles.personChoice} type="button" onClick={() => choose("person")} disabled={actionsDisabled}>{copy.askPerson}</button>
          </div>
          <div className={styles.statusPanel}>
            <span>{copy.statusLabel}</span>
            <p role="status" aria-live="polite" aria-atomic="true">{status}</p>
          </div>
        </div>
      </article>
    </section>
  );
}
