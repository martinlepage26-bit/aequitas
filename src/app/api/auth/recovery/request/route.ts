import { after } from "next/server";
import { issueAccountRecovery, revokeAccountRecovery } from "../../../../../lib/accountRecovery";
import { signOutOriginAllowed } from "../../../../../lib/authPaths";
import { emailConfigured, sendAccountRecoveryEmail } from "../../../../../lib/mail";

const GENERIC = { message: "If this address belongs to an Aequitas account, a recovery link will be sent." };

export async function POST(request: Request) {
  if (!signOutOriginAllowed(request.url, request.headers.get("origin"), process.env.APP_URL)) return Response.json({ message: "Invalid request origin." }, { status: 403 });
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ message: "Enter a valid email address." }, { status: 400 });
  if (!emailConfigured()) return Response.json({ message: "Email recovery is temporarily unavailable." }, { status: 503 });
  const issued = await issueAccountRecovery(email);
  if (issued) after(async () => {
    try {
      const result = await sendAccountRecoveryEmail({ email: issued.email, locale: issued.locale, token: issued.token, recoveryId: issued.recovery.id });
      if (result !== "accepted") await revokeAccountRecovery(issued.recovery.id);
    } catch {
      await revokeAccountRecovery(issued.recovery.id).catch(() => {});
      console.error("Account recovery email delivery failed.");
    }
  });
  return Response.json(GENERIC, { status: 202, headers: { "Cache-Control": "private, no-store" } });
}
