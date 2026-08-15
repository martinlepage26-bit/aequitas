import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// Route restructuring under /[locale] (and the middleware that negotiates
// it) is deferred to M2 per DECISIONS.md — this config is the next-intl
// scaffold proven by the M0 i18n-parity/forbidden-terms checks, not yet
// mounted at the live app root.
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
