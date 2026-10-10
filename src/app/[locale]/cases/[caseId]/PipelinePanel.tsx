import { getTranslations } from "next-intl/server";
import type { PipelineView } from "../../../../domain/pipeline/writes";
import { AddAssumptionForm, AssembleButton, AssumptionButtons, ProposalActions, ReturnForm } from "./PipelineForms";
import styles from "./workspace.module.css";

export default async function PipelinePanel({
  caseId,
  view,
  modelConfigured,
}: {
  caseId: string;
  view: PipelineView;
  modelConfigured: boolean;
}) {
  const t = await getTranslations("workspace.pipeline");
  const claims = await getTranslations("workspace.claims");
  const confidence = {
    ESTABLISHED: claims("confidence.ESTABLISHED"),
    PROBABLE: claims("confidence.PROBABLE"),
    DISPUTED: claims("confidence.DISPUTED"),
    UNKNOWN: claims("confidence.UNKNOWN"),
  };
  const waiting = view.proposals.filter((proposal) => proposal.status === "PROPOSED");

  return (
    <section aria-labelledby="assumptions-heading" className={styles.section} data-pipeline-panel>
      <h2 id="assumptions-heading">{t("title")}</h2>
      <p>{t("description")}</p>
      <p className={styles.hint}>{t("stage", { stage: t(`stageName.${view.stage as "EPOCHE"}`) })}</p>
      {view.assumptions.length === 0 ? (
        <p>{t("emptyAssumptions")}</p>
      ) : (
        <ul>
          {view.assumptions.map((assumption) => (
            <li key={assumption.id} className={styles.claim}>
              <p className={styles.claimMeta}>
                <span className={styles.claimType}>{t(`assumptionStatus.${assumption.status as "PROPOSED"}`)}</span>
                {" · "}
                {t(`origin.${assumption.origin as "CASE_FRAMING"}`)}
              </p>
              <p className={styles.recordText}>{assumption.text}</p>
              {view.canAuthor && assumption.status === "PROPOSED" && (
                <AssumptionButtons caseId={caseId} assumptionId={assumption.id} acknowledge={t("acknowledge")} challenge={t("challenge")} />
              )}
            </li>
          ))}
        </ul>
      )}
      {view.canAuthor && <AddAssumptionForm caseId={caseId} label={t("addLabel")} button={t("addButton")} />}

      <h2 id="proposals-heading">{t("proposalsTitle")}</h2>
      <p>{t("proposalsDescription")}</p>
      {!modelConfigured && <p className={styles.hint}>{t("modelOff")}</p>}
      {waiting.length === 0 ? (
        <p>{t("emptyProposals")}</p>
      ) : (
        <ul>
          {waiting.map((proposal) => (
            <li key={proposal.id} className={styles.claim} data-proposal-status="awaiting">
              <p className={styles.claimMeta}>
                <span className={styles.claimType}>{t(`kind.${proposal.kind as "CLAIM"}`)}</span>
                {" · "}
                {t("awaiting")}
              </p>
              <p className={styles.recordText}>{proposal.text}</p>
              {proposal.excerpt && (
                <p className={styles.hint}>{t("excerptLabel")}: {proposal.excerpt}</p>
              )}
              {view.canAuthor && (
                <ProposalActions
                  caseId={caseId}
                  proposalId={proposal.id}
                  kind={proposal.kind}
                  accept={t("accept")}
                  reject={t("reject")}
                  confidenceLabel={t("confidence")}
                  rationaleLabel={t("rationale")}
                  confidence={confidence}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {view.synthesis && (
        <>
          <h3>{t("flagsTitle")}</h3>
          <p className={styles.hint}>{t("flagsNote")}</p>
          <ul className={styles.flags}>
            <li className={styles.flag}>{t("flagEvidence")}: {t(`diagE.${view.synthesis.diagE as "insufficient"}`)}</li>
            <li className={styles.flag}>{t("flagPositionality")}: {t(`diagP.${view.synthesis.diagP as "positionality_gap"}`)}</li>
            <li className={styles.flag}>{t("flagContext")}: {t(`diagC.${view.synthesis.diagC as "third_factor_missing"}`)}</li>
          </ul>
        </>
      )}

      {view.canAuthor && (
        <>
          <AssembleButton caseId={caseId} label={t("assemble")} />
          <ReturnForm
            caseId={caseId}
            title={t("returnTitle")}
            reasonLabel={t("returnReason")}
            button={t("returnButton")}
            stages={["EPOCHE", "CLAIM_DECOMPOSITION", "CONTEXT_MAPPING", "SYNTHESIS"].map((value) => ({
              value,
              label: t(`stageName.${value as "EPOCHE"}`),
            }))}
          />
        </>
      )}
    </section>
  );
}
