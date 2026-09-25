import { buildKnowledgeSources } from "./prompts/conflictKnowledge";
import { validateConflictKnowledgeMap } from "../domain/conflictKnowledge";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { coreAiGeneratedFieldsSchema, type ExplanationRecord } from "../domain/explanationRecord";
import { buildDraftSystemPrompt, buildDraftUserPrompt, PROMPT_VERSION, type DraftPromptInput } from "./prompts/draftRecommendation";

/**
 * Section 9: "Use the Anthropic SDK's structured output / tool-use mode so
 * the response is schema-conformant by construction. Pin ANTHROPIC_MODEL;
 * record it per draft." `output_config: { format: zodOutputFormat(...) }`
 * was the original structured-output path (schema enforced server-side via
 * constrained decoding), but coreAiGeneratedFieldsSchema's nested
 * enums/arrays (conflict_knowledge especially) compile into a grammar too
 * large for that feature (400 "The compiled grammar is too large").
 *
 * Instead: the exact JSON Schema is spelled out in the system prompt
 * (prompts/draftRecommendation.ts's OUTPUT_JSON_SCHEMA), the model responds
 * in plain text, and `outputFormat.parse()` below runs the identical
 * zodObject.safeParse() a real output_config call would have run. Schema
 * conformance is no longer *guaranteed* by the API, but it is still fully
 * *validated* before anything is treated as a valid draft — and
 * `explanationRecordSchema` re-validates again in mutate.ts's completeDraft.
 * Two passes of the same schema is deliberate, not redundant: this call
 * proves the *shape* Claude returned; completeDraft's guard is what makes
 * the shape-plus-semantics check the actual gate the state machine enforces
 * (citations resolve to case evidence is a DB check no Zod schema alone can
 * make).
 */

const outputFormat = zodOutputFormat(coreAiGeneratedFieldsSchema);

function stripCodeFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : text;
}

export type DraftResult =
  | { ok: true; explanation: ExplanationRecord }
  | { ok: false, reason: string };



export async function draftRecommendation(input: DraftPromptInput): Promise<DraftResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Same honest "not configured" shape the retired M0 demo used, rather
    // than crashing — no live key exists in
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
    maxRetries: 1,
    // No explicit timeout: let the SDK size it from max_tokens (its
    // calculateNonstreamingTimeout gives 16000 max_tokens ~10 minutes). A
    // fixed 120s here previously aborted real generations of the full
    // conflict-knowledge-map response before they could finish.
    // Org-wide (unscoped) API keys require this header naming which
    // workspace to bill/authorize against; workspace-scoped keys don't.
    defaultHeaders: workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined,
  });

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 16000,
      system: buildDraftSystemPrompt(input.category),
      messages: [{ role: "user", content: buildDraftUserPrompt(input) }],
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

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) return { ok: false, reason: "The AI's response did not include any text content." };

  let parsedOutput;
  try {
    parsedOutput = outputFormat.parse(stripCodeFence(text));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `The AI's response did not match the required schema: ${detail}` };
  }

  const knowledgeSources = buildKnowledgeSources(input);
  const mapError = validateConflictKnowledgeMap(parsedOutput.conflict_knowledge, knowledgeSources);
  if (mapError) return { ok: false, reason: `Conflict map validation failed: ${mapError}` };

  return {
    ok: true,
    explanation: {
      ...parsedOutput,
      knowledge_sources: knowledgeSources,
      model: { id: response.model, prompt_version: PROMPT_VERSION },
      reviewer: { user_id: null, issued_at: null },
    },
  };
}
