import { requireSession } from "../../../../../lib/session";
import { prisma } from "../../../../../lib/prisma";
import { emailConfigured, sendInvitationEmail } from "../../../../../lib/mail";
import { invitationTokenHash, revokeInvitation } from "../../../../../lib/invitations";
import { invitePath, issueInviteToken } from "../../../../../lib/invite";

/** The complainant explicitly confirms the current respondent address before an activation email is sent. */
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  if (auth.session.globalRole !== "COMPLAINANT") return Response.json({ message: "Only the complainant can invite the respondent." }, { status: 403 });
  const { caseId } = await params;
  const body = await request.json().catch(() => null);
  const confirmedEmail = typeof body?.confirmedEmail === "string" ? body.confirmedEmail.trim().toLowerCase() : "";
  if (!emailConfigured()) return Response.json({ message: "Invitation email is unavailable." }, { status: 503 });
  // Lock the dossier while checking its recipient and recording the invitation.
  // The edit path takes the same lock and refuses an active invitation.
  const prepared = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${caseId} FOR UPDATE`;
    const row = await tx.case.findUnique({ where: { id: caseId }, include: { respondent: { include: { _count: { select: { credentials: true } } } } } });
    if (!row || row.complainantId !== auth.session.userId) return { kind: "error" as const, message: "Dossier not found.", status: 404 as const };
    if (row.state !== "OPEN" && row.state !== "EVIDENCE_INTAKE") return { kind: "error" as const, message: "Submit the dossier before inviting the respondent.", status: 409 as const };
    if (!confirmedEmail || confirmedEmail !== row.respondent.email.toLowerCase()) return { kind: "error" as const, message: "The respondent address changed. Reload and confirm the current address.", status: 409 as const };
    if (row.respondent._count.credentials > 0) return { kind: "error" as const, message: "The respondent already has an active passkey.", status: 409 as const };
    const active = await tx.invitation.findFirst({ where: { userId: row.respondentId, revokedAt: null, claimedAt: null, expiresAt: { gt: new Date() }, emailedAt: { not: null } }, orderBy: { createdAt: "desc" } });
    if (active) return { kind: "already_sent" as const, expiresAt: active.expiresAt };
    const { token, expiresAt } = issueInviteToken(row.respondentId);
    await tx.invitation.updateMany({ where: { userId: row.respondentId, revokedAt: null, claimedAt: null }, data: { revokedAt: new Date() } });
    const invitation = await tx.invitation.create({ data: { userId: row.respondentId, tokenHash: invitationTokenHash(token), issuedById: auth.session.userId, locale: row.respondent.locale, expiresAt } });
    return { kind: "issued" as const, email: row.respondent.email, locale: row.respondent.locale, token, expiresAt, invitationId: invitation.id };
  });
  if (prepared.kind === "error") return Response.json({ message: prepared.message }, { status: prepared.status });
  if (prepared.kind === "already_sent") return Response.json({ status: "already_sent", expiresAt: prepared.expiresAt.toISOString() }, { headers: { "Cache-Control": "private, no-store" } });
  try {
    const delivery = await sendInvitationEmail({ email: prepared.email, locale: prepared.locale, claimPath: invitePath(prepared.locale, prepared.token), invitationId: prepared.invitationId });
    if (delivery !== "accepted") {
      await revokeInvitation(prepared.invitationId);
      return Response.json({ message: "Invitation email is unavailable." }, { status: 503 });
    }
  } catch {
    await revokeInvitation(prepared.invitationId).catch(() => {});
    return Response.json({ message: "The invitation could not be emailed. Please retry." }, { status: 502 });
  }
  return Response.json({ status: "sent", expiresAt: prepared.expiresAt.toISOString() }, { headers: { "Cache-Control": "private, no-store" } });
}
