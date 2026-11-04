/**
 * Markers for a recommendation draft written by the assigned case manager
 * rather than by a model. They are stored in the explanation record's
 * `model` block and on the Recommendation row so every reader can tell the
 * two origins apart. Server-set only; never accepted from request bodies.
 */
export const HUMAN_AUTHORED_MODEL_ID = "human:case-manager";
export const HUMAN_AUTHORED_PROMPT_VERSION = "human-authored";

export function isHumanAuthoredModel(modelId: string | null | undefined): boolean {
  return modelId === HUMAN_AUTHORED_MODEL_ID;
}
