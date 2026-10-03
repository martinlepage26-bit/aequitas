import createMiddleware from "next-intl/middleware";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";

/** Nonces and security headers cover dynamic pages and APIs; next-intl handles locale routes. */
const localize = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Production rewrites can decode route parameters again. Validate both
  // forms before a literal percent reaches Next's dynamic route matcher.
  try { decodeURI(decodeURI(pathname)); } catch {
    return NextResponse.json({ message: "Malformed URL." }, { status: 400 });
  }

  const locale = routing.locales.find(value => pathname === `/${value}` || pathname.startsWith(`/${value}/`)) ?? routing.defaultLocale;
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'", // Existing React style attributes need this; script execution requires a nonce.
    "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-aequitas-locale", locale);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const localized = /^\/(?:fr-CA|en-CA|cases)(?:\/|$)/.test(pathname);
  const response = localized
    ? localize(new NextRequest(request, { headers: requestHeaders }))
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|images/|favicon.ico).*)"],
};
