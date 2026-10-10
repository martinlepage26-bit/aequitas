import { requireSession } from "../../../../../../../lib/session";
import { mutationFailureResponse } from "../../../../../../../domain/mutate";
import { acceptClaimProposal, acceptContextProposal, rejectProposal } from "../../../../../../../domain/pipeline/writes";
import { prisma } from "../../../../../../../lib/prisma";

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string; proposalId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { caseId, proposalId } = await params;
  const body = await request.json().catch(() => null) as {
    action?: string;
    confidence?: "ESTABLISHED" | "PROBABLE" | "DISPUTED" | "UNKNOWN";
    confidenceRationale?: string | null;
    locale?: "fr-CA" | "en-CA";
  } | null;
  const actor = { caseId, proposalId, actorId: auth.session.userId, actorRole: auth.session.globalRole };
  if (body?.action === "reject") {
    const outcome = await rejectProposal(actor);
    if (!outcome.ok) return mutationFailureResponse(outcome)!;
    return Response.json({ id: outcome.data.id }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const proposal = await prisma.pipelineProposal.findFirst({ where: { id: proposalId, caseId }, select: { kind: true } });
  const outcome = proposal?.kind === "CONTEXT_FACTOR"
    ? await acceptContextProposal(actor)
    : await acceptClaimProposal({
        ...actor,
        confidence: body?.confidence ?? "UNKNOWN",
        confidenceRationale: body?.confidenceRationale,
        locale: body?.locale ?? "fr-CA",
      });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;
  return Response.json(outcome.data, { headers: { "Cache-Control": "private, no-store" } });
}
