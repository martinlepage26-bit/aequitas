import { routing } from "../i18n/routing";

export function authLocale(value: unknown): "fr-CA" | "en-CA" {
  return value === "en-CA" ? "en-CA" : routing.defaultLocale;
}

/** Return paths stay inside this locale's workspace; never accept an external redirect. */
export function authReturnPath(locale: string, value: unknown): string {
  if (typeof value !== "string" || value.includes("\\") || /[\r\n]/.test(value)) return `/${locale}/cases`;
  if (!value.startsWith(`/${locale}/cases`) && value !== `/${locale}/admin/invites`) return `/${locale}/cases`;
  try {
    const parsed = new URL(value, "https://aequitas.invalid");
    if (parsed.origin !== "https://aequitas.invalid" || !/^\/(?:fr-CA|en-CA)\/(?:cases(?:\/|$)|admin\/invites$)/.test(parsed.pathname)) return `/${locale}/cases`;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch { return `/${locale}/cases`; }
}

export function signInPath(locale: string, returnTo?: string): string {
  return `/${locale}/auth/sign-in${returnTo ? `?next=${encodeURIComponent(authReturnPath(locale, returnTo))}` : ""}`;
}

/** The public origin may differ from the route URL behind a trusted proxy. */
export function signOutOriginAllowed(requestUrl: string, origin: string | null, appUrl?: string): boolean {
  if (!origin) return true;
  const requestOrigin = new URL(requestUrl).origin;
  return origin === requestOrigin || (appUrl ? origin === new URL(appUrl).origin : false);
}
