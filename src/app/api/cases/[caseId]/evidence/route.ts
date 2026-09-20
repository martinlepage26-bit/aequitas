import { detectEvidenceMime } from "../../../../../lib/evidenceText";
import { requireSession } from "../../../../../lib/session";
import { mutationFailureResponse, submitEvidence } from "../../../../../domain/mutate";
import { EVIDENCE_KINDS } from "../../../../../domain/evidenceKinds";
import type { EvidenceKind } from "../../../../../generated/prisma";

// Section 11: "Uploads: multipart, size-capped (25 MB default), MIME-sniffed
// server-side..." The client's declared Content-Type is never trusted for
// the stored mimeType — only the magic-number sniff result is.
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ message: "Expected multipart/form-data." }, { status: 400 });

  const file = form.get("file");
  const kind = form.get("kind");
  const title = form.get("title");
  const description = form.get("description");

  if (!(file instanceof File)) return Response.json({ message: "A file is required." }, { status: 400 });
  if (typeof kind !== "string" || !EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
    return Response.json({ message: `kind must be one of: ${EVIDENCE_KINDS.join(", ")}` }, { status: 400 });
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return Response.json({ message: "title is required." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ message: `File exceeds the ${MAX_BYTES / (1024 * 1024)} MB limit.` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = await detectEvidenceMime(buffer);
  if (!mimeType) {
    return Response.json({ message: "Could not determine the file's type from its contents." }, { status: 400 });
  }

  const outcome = await submitEvidence({
    actorId: session.userId,
    actorRole: session.globalRole,
    caseId,
    kind: kind as EvidenceKind,
    title,
    description: typeof description === "string" && description.trim().length > 0 ? description : undefined,
    buffer,
    mimeType,
  });
  if (!outcome.ok) return mutationFailureResponse(outcome)!;

  return Response.json({ caseId: outcome.data.caseId, state: outcome.data.toState });
}
