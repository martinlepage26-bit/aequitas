/**
 * Where a prospective pilot program can reach the team. Set
 * AEQUITAS_PILOT_CONTACT_URL to an https: booking/contact page or a
 * mailto: address. Unset or any other scheme hides the call to action, so
 * the landing page never shows a dead or invented contact.
 *
 * The landing page is statically generated, so the value is read at build.
 */
export function pilotContactUrl(value: string | undefined = process.env.AEQUITAS_PILOT_CONTACT_URL): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || (url.protocol === "mailto:" && url.pathname.includes("@"))) return url.toString();
  } catch {
    return null;
  }
  return null;
}
