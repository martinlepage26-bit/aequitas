import { prisma } from "../../../../lib/prisma";
import { requireSession } from "../../../../lib/session";
import { invitePath } from "../../../../lib/invite";
import { issueStoredInvite, revokeInvitation } from "../../../../lib/invitations";
import { emailConfigured, sendInvitationEmail, deliverPendingNotifications } from "../../../../lib/mail";
import { routing } from "../../../../i18n/routing";

// ADMIN is never provisioned through an invite (no staff-access model yet).
const INVITABLE_ROLES = ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER"] as const;

/**
 * POST /api/auth/invite — ADMIN only. Provisions (or reuses) an account
 * that has no passkey yet and returns a single-use claim link for it. This
 * is the only way to create a CASE_MANAGER (H1), and the only way a
 * placeholder respondent created by a complainant's intake becomes a real,
 * signed-in account (C1). Delivery through Resend is optional and requires an explicit sendEmail request.
 */
export async function POST(request: Request) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  if (auth.session.globalRole !== "ADMIN") {
    return Response.json({ message: "Only an administrator may issue invitations." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const { displayName, globalRole } = body ?? {};
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const locale = body?.locale ?? routing.defaultLocale;
  if (typeof email !== "string" || !email.includes("@")) {
    return Response.json({ message: "A valid email is required." }, { status: 400 });
  }
  if (!INVITABLE_ROLES.includes(globalRole)) {
    return Response.json({ message: `globalRole must be one of ${INVITABLE_ROLES.join(", ")}.` }, { status: 400 });
  }
  if (!(routing.locales as readonly string[]).includes(locale)) {
    return Response.json({ message: `locale must be one of ${routing.locales.join(", ")}.` }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email }, include: { _count: { select: { credentials: true } } } });
  if (existing && existing.globalRole !== globalRole) {
    return Response.json({ message: "That email already belongs to an account with a different role." }, { status: 409 });
  }
  if (existing && existing._count.credentials > 0) {
    return Response.json({ message: "That account has already been claimed with a passkey." }, { status: 409 });
  }
  if (!existing && (typeof displayName !== "string" || displayName.trim().length === 0)) {
    return Response.json({ message: "displayName is required for a new account." }, { status: 400 });
  }

  const user =
    existing ??
    (await prisma.user.create({ data: { email, displayName: displayName.trim(), globalRole, locale } }));

  let issued;
  try { issued = await issueStoredInvite(user.id, locale, auth.session.userId); }
  catch { return Response.json({ message: "This account cannot be invited." }, { status: 409 }); }
  const { token, expiresAt, invitation } = issued;
  const claimPath = invitePath(locale, token);
  let delivery: "manual" | "not_configured" | "accepted" | "failed" = "manual";
  if (body.sendEmail === true) {
    try { delivery = await sendInvitationEmail({ email, locale, claimPath, invitationId: invitation.id }); }
    catch { delivery = "failed"; }
  }
  return Response.json({ invitationId: invitation.id, userId: user.id, claimPath, expiresAt: expiresAt.toISOString(), delivery });
}

export async function GET() {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  if (auth.session.globalRole !== "ADMIN") return Response.json({ message: "Forbidden." }, { status: 403 });
  const invitations = await prisma.invitation.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, expiresAt: true, revokedAt: true, claimedAt: true, emailedAt: true, createdAt: true, user: { select: { email: true, displayName: true, globalRole: true } } } });
  return Response.json({ invitations, emailConfigured: emailConfigured() });
}

export async function DELETE(request: Request) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  if (auth.session.globalRole !== "ADMIN") return Response.json({ message: "Forbidden." }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body?.invitationId !== "string") return Response.json({ message: "invitationId is required." }, { status: 400 });
  const revoked = await revokeInvitation(body.invitationId);
  return Response.json({ revoked }, { status: revoked ? 200 : 404 });
}

export async function PATCH() {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  if (auth.session.globalRole !== "ADMIN") return Response.json({ message: "Forbidden." }, { status: 403 });
  return Response.json(await deliverPendingNotifications());
}
