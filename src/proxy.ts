import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

/**
 * Next.js 16 renamed the middleware.ts convention to proxy.ts (same
 * behavior, new file/export name — see node_modules/next/dist/docs
 * .../file-conventions/proxy.md). Scoped to the new locale-aware workspace
 * routes only — the M0-era SQLite demo homepage, /auth/sign-in, and every
 * /api/* route stay completely outside proxy, per DECISIONS.md's M0 note
 * that the routing restructure must not touch the currently-running demo
 * mid-milestone.
 */
export default createMiddleware(routing);

export const config = {
  matcher: ["/cases/:path*", "/(fr-CA|en-CA)/:path*"],
};
