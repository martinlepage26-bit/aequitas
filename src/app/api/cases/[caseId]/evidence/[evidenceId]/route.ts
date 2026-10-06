import { downloadCleanEvidence, evidenceDownloadHeaders } from "../../../../../../domain/evidenceAccess";
import { requireSession } from "../../../../../../lib/session";

// CLEAN evidence only, for a party or the assigned case manager.
// Anyone else, and any file that failed scanning, gets the same 404 as a missing case.
export async function GET(_request: Request, { params }: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId, evidenceId } = await params;

  const result = await downloadCleanEvidence({
    actorId: session.userId,
    actorRole: session.globalRole,
    caseId,
    evidenceId,
  });
  if (!result.ok) {
    const message = result.status === 404 ? "Case not found." : "The file could not be read.";
    return Response.json({ message }, { status: result.status });
  }

  return new Response(new Uint8Array(result.body), {
    headers: evidenceDownloadHeaders({
      mimeType: result.mimeType,
      contentDisposition: result.contentDisposition,
      byteLength: result.body.byteLength,
    }),
  });
}
