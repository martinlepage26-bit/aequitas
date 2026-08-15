import { defineRouting } from "next-intl/routing";

// fr-CA is co-equal with en-CA, not a translation target — see
// aequitas-implementation-handoff.md Section 12 (Bill 96 posture).
export const routing = defineRouting({
  locales: ["fr-CA", "en-CA"],
  defaultLocale: "fr-CA",
});

export type AppLocale = (typeof routing.locales)[number];
