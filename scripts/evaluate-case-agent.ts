import "../src/lib/loadEnv";
import { performance } from "node:perf_hooks";
import { checkAgentOutput } from "../src/domain/caseAgent/output";
import { buildCaseAgentOutputContext, buildCaseAgentPrompt } from "../src/domain/caseAgent/prompt";
import { SYNTHETIC_CASE_AGENT_EVALUATION } from "../src/domain/caseAgent/syntheticEvaluation";
import { resolveFreeTextModel } from "../src/domain/pipeline/provider";

/**
 * One-request provider check using synthetic material only. It has no Prisma
 * or storage imports and writes no result. A human must review the output;
 * deterministic validation is not a quality or neutrality certificate.
 */
async function main() {
  if (process.env.AEQUITAS_CASE_AGENT_EVAL_SYNTHETIC_ONLY !== "true") {
    console.error("BLOCKED: set AEQUITAS_CASE_AGENT_EVAL_SYNTHETIC_ONLY=true to confirm this run uses synthetic material only. No provider request was sent.");
    process.exitCode = 2;
    return;
  }
  const provider = process.env.AEQUITAS_CASE_AGENT_EVAL_PROVIDER?.trim().toLowerCase();
  if (provider !== "gemini" && provider !== "workers-ai") {
    console.error("BLOCKED: set AEQUITAS_CASE_AGENT_EVAL_PROVIDER explicitly to gemini or workers-ai. No provider request was sent.");
    process.exitCode = 2;
    return;
  }
  const resolved = resolveFreeTextModel({
    ...process.env,
    AEQUITAS_PIPELINE_ENABLED: "true",
    AEQUITAS_PIPELINE_PROVIDER: provider,
  });
  if (!resolved.ok) {
    console.error(`BLOCKED: ${resolved.reason} No provider request was sent.`);
    process.exitCode = 2;
    return;
  }

  const fixture = SYNTHETIC_CASE_AGENT_EVALUATION;
  const prompt = buildCaseAgentPrompt(fixture.material, fixture.evidenceSources);
  const context = buildCaseAgentOutputContext(fixture.material, fixture.evidenceSources);
  const started = performance.now();
  let raw: string;
  try {
    raw = await resolved.model.complete(prompt);
  } catch {
    console.log(JSON.stringify({
      evaluation: "synthetic-case-agent-single-request",
      synthetic_only: true,
      provider: resolved.model.provider,
      model: resolved.model.model,
      requests: 1,
      elapsed_ms: Math.round(performance.now() - started),
      deterministic_result: "provider_request_failed",
      human_quality_review_required: true,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const elapsedMs = Math.round(performance.now() - started);
  const checked = checkAgentOutput(raw, context);
  const report = checked.ok
    ? {
        evaluation: "synthetic-case-agent-single-request",
        synthetic_only: true,
        provider: resolved.model.provider,
        model: resolved.model.model,
        requests: 1,
        elapsed_ms: elapsedMs,
        deterministic_result: "passed",
        citation_count: checked.value.citations.length,
        expected_output_locales: fixture.expectedLocales,
        language_quality_check: "manual",
        human_quality_review_required: true,
        sample_output: {
          summary: checked.value.summary,
          reasoning: checked.value.reasoning,
          citations: checked.value.citations,
          outcomes: checked.value.outcomes,
        },
        limitation: "Passing these checks does not establish factual accuracy, neutrality, legal adequacy, or suitability for real cases.",
      }
    : {
        evaluation: "synthetic-case-agent-single-request",
        synthetic_only: true,
        provider: resolved.model.provider,
        model: resolved.model.model,
        requests: 1,
        elapsed_ms: elapsedMs,
        deterministic_result: checked.escalation,
        reason: checked.detail,
        response_excerpt: raw.slice(0, 2000),
        human_quality_review_required: true,
      };
  console.log(JSON.stringify(report, null, 2));
  if (!checked.ok) process.exitCode = 1;
}

main().catch(() => {
  // Do not echo provider or transport exceptions; they can contain request metadata.
  console.error("Synthetic case-agent evaluation failed. No case records were read or written.");
  process.exitCode = 1;
});
