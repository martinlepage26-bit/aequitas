import { buildKnowledgeSources } from "./prompts/conflictKnowledge";
import { validateConflictKnowledgeMap } from "../domain/conflictKnowledge";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { coreAiGeneratedFieldsSchema, type ExplanationRecord } from "../domain/explanationRecord";
import { buildDraftSystemPrompt, buildDraftUserPrompt, PROMPT_VERSION, type DraftPromptInput } from "./prompts/draftRecommendation";

/**
 * Section 9: "Use the Anthropic SDK's structured output / tool-use mode so
 * the response is schema-conformant by construction. Pin ANTHROPIC_MODEL;
 * record it per draft." `client.messages.parse()` + `zodOutputFormat()` is
 * the current SDK's structured-output path — the response is constrained
 * to the schema server-side, then parsed and validated client-side against
 * the exact same Zod schema `explanationRecordSchema` re-validates against
 * in mutate.ts's completeDraft. Two passes of the same schema is
 * deliberate, not redundant: this call proves the *shape* Claude returned;
 * completeDraft's guard is what makes the shape-plus-semantics check the
 * actual gate the state machine enforces (citations resolve to case
 * evidence is a DB check no Zod schema alone can make).
 */

export type DraftResult =
  | { ok: true; explanation: ExplanationRecord }
  | { ok: false, reason: string };



export async function draftRecommendation(input: DraftPromptInput): Promise<DraftResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Matches the legacy src/lib/ai.js pattern (M0-era code, same honest
    // "not configured" shape) rather than crashing — no live key exists in
    // this build environment; see DECISIONS.md M3. Anthropic({apiKey}) with
    // an empty/undefined key throws synchronously at construction, so this
    // check must happen before the client is ever built.
    return { ok: false, reason: "AI recommendation drafting is unavailable: ANTHROPIC_API_KEY has not been configured for this environment." };
  }

  const model = process.env.ANTHROPIC_MODEL;
  if (!model) return { ok: false, reason: "AI drafting is unavailable: ANTHROPIC_MODEL must name a model enabled for this account." };

  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic({
    apiKey,
    timeout: 120000,
    maxRetries: 1,
    // Org-wide (unscoped) API keys require this header naming which
    // workspace to bill/authorize against; workspace-scoped keys don't.
    defaultHeaders: workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined,
  });

  let response;
  try {
    response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system: buildDraftSystemPrompt(input.category),
      messages: [{ role: "user", content: buildDraftUserPrompt(input) }],
      output_config: { format: zodOutputFormat(coreAiGeneratedFieldsSchema) },
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return { ok: false, reason: `AI service error (${error.status ?? "unknown"}). Check the configured model and account access, then retry.` };
    }
    return { ok: false, reason: "The AI response could not be validated. The case remains available for retry and human review." };
  }

  if (response.stop_reason === "refusal") {
    const refusalCategory = response.stop_details?.type === "refusal" ? response.stop_details.category : null;
    return {
      ok: false,
      reason: `The AI declined to draft a recommendation for this case${refusalCategory ? ` (category: ${refusalCategory})` : ""}.`,
    };
  }

  if (response.stop_reason === "max_tokens") return { ok: false, reason: "The AI response was truncated. No draft was saved; retry with a smaller case record." };

  if (!response.parsed_output) {
    return { ok: false, reason: "The AI's response did not match the required schema." };
  }

  const knowledgeSources = buildKnowledgeSources(input);
  const mapError = validateConflictKnowledgeMap(response.parsed_output.conflict_knowledge, knowledgeSources);
  if (mapError) return { ok: false, reason: `Conflict map validation failed: ${mapError}` };

  return {
    ok: true,
    explanation: {
      ...response.parsed_output,
      knowledge_sources: knowledgeSources,
      model: { id: response.model, prompt_version: PROMPT_VERSION },
      reviewer: { user_id: null, issued_at: null },
    },
  };
}
