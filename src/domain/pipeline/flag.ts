/** The pipeline stays off unless this is exactly the string "true". */
export function pipelineEnabled(env?: { AEQUITAS_PIPELINE_ENABLED?: string }): boolean {
  return (env?.AEQUITAS_PIPELINE_ENABLED ?? process.env.AEQUITAS_PIPELINE_ENABLED) === "true";
}

export const PIPELINE_OFF_REASON =
  "The analysis pipeline is off. It stays off until AEQUITAS_PIPELINE_ENABLED=true and a free-tier key are set.";
