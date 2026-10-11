import { requireSession } from "../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../domain/mutate";
import { runAssumptionExtraction, runClaimDecomposition, runContextMapping } from "../../../../../../domain/pipeline/writes";

const STEPS = {
  claims: runClaimDecomposition,
  context: runContextMapping,
  assumptions: runAssumptionExtraction,
} as const;

type Step = keyof typeof STEPS;

/**
 * Asks the free model for proposals on one pipeline step. The write functions
 * enforce AEQUITAS_PIPELINE_ENABLED, case access, the acknowledgement gate, the
 * output contracts, and the verbatim-excerpt check. The result is proposals
 * only; nothing becomes a claim until the case manager accepts it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId } = await params;
  const body = await request.json().catch(() => null) as { step?: unknown } | null;
  const step = body?.step;
  if (typeof step !== "string" || !Object.hasOwn(STEPS, step)) {
    return Response.json({ message: "step must be claims, context, or assumptions." }, { status: 400 });
  }
  const outcome = await STEPS[step as Step]({
    caseId,
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json({ step, ids: outcome.data.ids }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
}
