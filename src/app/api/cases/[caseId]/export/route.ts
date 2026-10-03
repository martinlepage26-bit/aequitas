import { recordStaffAccess } from "../../../../../domain/staffAccess";
import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { generateExportBundle } from "../../../../../domain/exportBundle";
import { downloadBuffer } from "../../../../../lib/storage";

// Section 16: "GET /api/cases/[id]/export — generate/fetch bundle". Section
// 10's access row: parties get their OWN CLOSED case only (never trigger
// generation themselves — only close_case does, via /close); any assigned
// case manager can fetch, and may generate on demand (e.g. previewing an
// export before closing).
export async function GET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return Response.json({ message: "Case not found." }, { status: 404 });

  const isParty = session.userId === caseRow.complainantId || session.userId === caseRow.respondentId;
  const isAssignedManager = session.globalRole === "CASE_MANAGER" && session.userId === caseRow.caseManagerId;
  const isAdmin = session.globalRole === "ADMIN";

  if (isParty && caseRow.state !== "CLOSED") return Response.json({ message: "Case not found." }, { status: 404 });
  if (!isParty && !isAssignedManager && !isAdmin) return Response.json({ message: "Case not found." }, { status: 404 });

  await recordStaffAccess(caseId, session, "export");
  let bundle = await prisma.exportBundle.findFirst({ where: { caseId }, orderBy: { generatedAt: "desc" } });
  if (!bundle) {
    if (isParty) return Response.json({ message: "No export bundle exists for this case yet." }, { status: 404 });
    const generated = await generateExportBundle({ caseId, actorId: session.userId });
    bundle = await prisma.exportBundle.findUniqueOrThrow({ where: { storageKey: generated.storageKey } });
  }

  const buffer = await downloadBuffer(bundle.storageKey);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${caseRow.referenceNumber}-export.zip"`,
      "X-Export-Sha256": bundle.sha256,
    },
  });
}
