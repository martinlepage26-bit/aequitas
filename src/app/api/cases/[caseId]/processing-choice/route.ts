import { z } from "zod";
import { requireSession } from "../../../../../lib/session";
import { acceptCaseAgentProcessing } from "../../../../../domain/caseAgent/agent";

const choiceSchema = z.object({
  noticeHash: z.string().regex(/^[a-f0-9]{64}$/),
  locale: z.enum(["en-CA", "fr-CA"]),
}).strict();

// POST /api/cases/[id]/processing-choice — one party accepts the current
// provider notice for this case. No evidence is sent to the provider until
// both parties' current choices match the active notice.
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const parsed = choiceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ message: "A current notice hash and locale are required." }, { status: 400 });
  const { caseId } = await params;
  const result = await acceptCaseAgentProcessing({
    actorId: auth.session.userId,
    actorRole: auth.session.globalRole,
    caseId,
    noticeHash: parsed.data.noticeHash,
    locale: parsed.data.locale,
  });
  if (!result.ok) return Response.json({ message: result.reason }, { status: result.status });
  return Response.json({ caseId, accepted: true }, { headers: { "Cache-Control": "private, no-store" } });
}
