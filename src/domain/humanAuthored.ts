/**
 * Markers for a recommendation draft written by the assigned case manager
 * rather than by a model. They are stored in the explanation record's
 * `model` block and on the Recommendation row so every reader can tell the
 * two origins apart. Server-set only; never accepted from request bodies.
 */
export const HUMAN_AUTHORED_MODEL_ID = "human:case-manager";
export const HUMAN_AUTHORED_PROMPT_VERSION = "human-authored";

/** A human-written recommendation must rest on at least this many citations to clean evidence in the same case. */
export const HUMAN_AUTHORED_MIN_CITATIONS = 1;

export function isHumanAuthoredModel(modelId: string | null | undefined): boolean {
  return modelId === HUMAN_AUTHORED_MODEL_ID;
}

/**
 * Issuance-time origin check. The conflict-map requirement for model drafts
 * is waived only when the row AND the stored explanation both carry the
 * human markers; any disagreement is treated as tampering and blocks
 * issuance. A human draft must still cite evidence.
 */
export function humanAuthoredIssueCheck(
  row: { modelId: string | null; promptVersion: string },
  explanation: { model?: { id?: string; prompt_version?: string }; evidence_citations?: unknown[] },
): { humanAuthored: boolean; error: string | null } {
  const markers = [
    row.modelId === HUMAN_AUTHORED_MODEL_ID,
    row.promptVersion === HUMAN_AUTHORED_PROMPT_VERSION,
    explanation.model?.id === HUMAN_AUTHORED_MODEL_ID,
    explanation.model?.prompt_version === HUMAN_AUTHORED_PROMPT_VERSION,
  ];
  if (markers.every((m) => !m)) return { humanAuthored: false, error: null };
  if (!markers.every(Boolean)) return { humanAuthored: false, error: "The draft's origin markers disagree; it cannot be issued." };
  if ((explanation.evidence_citations?.length ?? 0) < HUMAN_AUTHORED_MIN_CITATIONS) {
    return { humanAuthored: true, error: "A recommendation written by the case manager must cite at least one piece of clean evidence from this case." };
  }
  return { humanAuthored: true, error: null };
}
