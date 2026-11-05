import { cookies } from "next/headers";
import type { GlobalRole } from "../generated/prisma";
import { prisma } from "./prisma";
import { signPayload, verifyPayload } from "./signedCookie";

export const SESSION_COOKIE = "aequitas_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  purpose: "session";
  userId: string;
  globalRole: GlobalRole;
  /** Section 7's authContext needs the real authentication method, not an assumed one. */
  authMethod: "passkey" | "dev-bypass";
  sessionVersion?: number;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const payload = verifyPayload<Partial<SessionPayload>>(token);
  if (!payload || payload.purpose !== "session" || typeof payload.userId !== "string" || !payload.userId.trim()) return null;
  if (!["COMPLAINANT", "RESPONDENT", "CASE_MANAGER", "ADMIN"].includes(payload.globalRole ?? "")) return null;
  if (payload.authMethod !== "passkey" && payload.authMethod !== "dev-bypass") return null;
  if (payload.sessionVersion !== undefined && (!Number.isSafeInteger(payload.sessionVersion) || payload.sessionVersion < 0)) return null;
  return { ...payload, sessionVersion: payload.sessionVersion ?? 0 } as SessionPayload;
}

export async function createSessionCookie(payload: Omit<SessionPayload, "purpose" | "sessionVersion">) {
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { globalRole: true, sessionVersion: true } });
  if (!user || user.globalRole !== payload.globalRole) throw new Error("Cannot create a session for this account.");
  const token = signPayload({ ...payload, sessionVersion: user.sessionVersion, purpose: "session" }, SESSION_TTL_SECONDS);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = verifySessionToken(token);
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { globalRole: true, sessionVersion: true } });
  if (!user || user.globalRole !== session.globalRole || user.sessionVersion !== session.sessionVersion) return null;
  return session;
}

/**
 * The raw signed cookie value, for callers that need a stable per-login
 * identifier (Section 7's authContext "session id") — Section 5's schema
 * defines no Session table (see signedCookie.ts), so the token itself, not
 * a DB row id, is the only thing unique to this login.
 */
export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token && await getSession() ? token : null;
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** For route handlers: the resolved session, or a ready-to-return 401 Response. */
export async function requireSession(): Promise<{ session: SessionPayload } | { response: Response }> {
  const session = await getSession();
  if (!session) {
    return { response: Response.json({ message: "Not authenticated." }, { status: 401 }) };
  }
  return { session };
}
