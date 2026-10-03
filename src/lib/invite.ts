import { signPayload, verifyPayload } from "./signedCookie";

/** Signed invite format. Issuance/claim/revocation are persisted by invitations.ts. */
export const INVITE_TTL_SECONDS = 72 * 60 * 60;

interface InvitePayload {
  purpose: "invite";
  userId: string;
  nonce: string;
}

export function issueInviteToken(userId: string, ttlSeconds = INVITE_TTL_SECONDS): { token: string; expiresAt: Date } {
  const nonce = crypto.randomUUID();
  const token = signPayload<InvitePayload>({ purpose: "invite", userId, nonce }, ttlSeconds);
  return { token, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
}

/** The invited userId, or null for a forged, expired or non-invite token. */
export function verifyInviteToken(token: unknown): string | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const payload = verifyPayload<Partial<InvitePayload>>(token);
  if (!payload || payload.purpose !== "invite" || typeof payload.userId !== "string" || !payload.userId || typeof payload.nonce !== "string" || !payload.nonce) return null;
  return payload.userId;
}

export function invitePath(locale: string, token: string): string {
  return `/${locale}/invite/${encodeURIComponent(token)}`;
}
