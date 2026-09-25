import { signPayload, verifyPayload } from "./signedCookie";

/**
 * Single-use invite tokens for pre-created accounts (C1/H1 fix).
 *
 * A pre-created account — a placeholder respondent named by a complainant,
 * or a case manager provisioned by an admin — can no longer be taken over by
 * registering a passkey with its email. It is claimed only through an invite
 * token: HMAC-signed (same SESSION_SECRET mechanism as sessions, see
 * signedCookie.ts), bound to one userId, time-limited, and single-use: the
 * claim route accepts it only while the account has no passkey at all, and
 * checks that under a row lock in the same transaction that attaches the
 * first credential. Once claimed, every copy of the token is dead.
 *
 * Stateless by design, like sessions: Section 5's schema has no token table.
 * The trade-off is that an unclaimed token cannot be revoked early, only
 * left to expire (INVITE_TTL_SECONDS); logged in DECISIONS.md.
 */
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
  if (!payload || payload.purpose !== "invite" || typeof payload.userId !== "string") return null;
  return payload.userId;
}

export function invitePath(locale: string, token: string): string {
  return `/${locale}/invite/${encodeURIComponent(token)}`;
}
