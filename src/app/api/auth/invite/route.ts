import { prisma } from "../../../../lib/prisma";
import { requireSession } from "../../../../lib/session";
import { invitePath, issueInviteToken } from "../../../../lib/invite";
import { routing } from "../../../../i18n/routing";

// ADMIN is never provisioned through an invite (no staff-access model yet).
const INVITABLE_ROLES = ["COMPLAINANT", "RESPONDENT", "CASE_MANAGER"] as const;

/**
 * POST /api/auth/invite — ADMIN only. Provisions (or reuses) an account
 * that has no passkey yet and returns a single-use claim link for it. This
 * is the only way to create a CASE_MANAGER (H1), and the only way a
 * placeholder respondent created by a complainant's intake becomes a real,
 * signed-in account (C1). No email is sent (no email provider exists in
 * this build): the admin delivers the link out of band.
 */
export async function POST(request: Request) {
  const auth = await requireSession();
  if ("response" in auth) return auth.response;
  if (auth.session.globalRole !== "ADMIN") {
    return Response.json({ message: "Only an administrator may issue invitations." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const { email, displayName, globalRole } = body ?? {};
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

  const { token, expiresAt } = issueInviteToken(user.id);
  return Response.json({ userId: user.id, claimPath: invitePath(locale, token), expiresAt: expiresAt.toISOString() });
}
