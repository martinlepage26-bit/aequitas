import { cookies } from "next/headers";
import { clearSessionCookie } from "../../../../lib/session";
import { CHALLENGE_COOKIE } from "../../../../lib/webauthn";
import { authLocale } from "../../../../lib/authPaths";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ message: "Request not permitted." }, { status: 403 });
  }
  const form = await request.formData().catch(() => null);
  const locale = authLocale(form?.get("locale"));
  await clearSessionCookie();
  (await cookies()).delete(CHALLENGE_COOKIE);
  return new Response(null, { status: 303, headers: { Location: `/${locale}/auth/sign-in`, "Cache-Control": "no-store" } });
}
