import { prisma } from "../../../../../lib/prisma";
import { requireSession } from "../../../../../lib/session";
import { filterEventsForRole } from "../../../../../domain/eventTimeline";

// Section 16: "GET /api/cases/[id]/events — timeline (role-filtered)".
export async function GET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  const { session } = auth;
  const { caseId } = await params;

  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return Response.json({ message: "Case not found." }, { status: 404 });

  // Same RBAC-404 posture as the case workspace page (DECISIONS.md, Section
  // 16): a non-party, non-manager caller gets "not found", not 403 — this
  // never confirms the case exists to someone who isn't entitled to see it.
  const isParty = session.userId === caseRow.complainantId || session.userId === caseRow.respondentId;
  const isManagerOrAdmin = session.globalRole === "CASE_MANAGER" || session.globalRole === "ADMIN";
  if (!isParty && !isManagerOrAdmin) return Response.json({ message: "Case not found." }, { status: 404 });

  const events = await prisma.event.findMany({
    where: { caseId },
    orderBy: { seq: "asc" },
  });

  const actorIds = [...new Set(events.map((e) => e.actorId))];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } });
  const actorNameById = new Map(actors.map((a) => [a.id, a.displayName]));

  const visible = filterEventsForRole(events, session.globalRole);

  return Response.json(
    visible.map((e) => ({
      id: e.id,
      seq: e.seq,
      type: e.type,
      actorId: e.actorId,
      actorName: actorNameById.get(e.actorId) ?? null,
      createdAt: e.createdAt,
    }))
  );
}
