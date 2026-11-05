import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import PartyOutcomePanel from "../../src/app/[locale]/cases/[caseId]/PartyOutcomePanel";
import en from "../../messages/en-CA.json";
import fr from "../../messages/fr-CA.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

function panel(locale: string, messages: typeof en, pending: boolean): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <PartyOutcomePanel
        caseId="case-1"
        canWrite
        locale={locale}
        parties={[{
          partyId: "party-1",
          displayName: "Northwind",
          issued: { id: "outcome-1", version: 1, status: "ISSUED", body: "Issued text", locale, issuedAt: null, citations: [] },
          draft: pending ? { id: "outcome-2", version: 2, status: "DRAFT", body: "Draft text", locale, issuedAt: null, citations: [] } : null,
        }]}
      />
    </NextIntlClientProvider>,
  );
}

describe("unissued outcome revision", () => {
  it("warns the mediator, in English and French, when consent is still open on the older version", () => {
    const english = panel("en-CA", en, true);
    const french = panel("fr-CA", fr, true).replaceAll("&#x27;", "'").replaceAll("&#39;", "'");
    expect(english).toContain("An unissued revision is pending. Consent is still open on version 1.");
    expect(french).toContain("Une révision non émise est en attente. Le consentement est encore ouvert sur la version 1.");
    expect(english).toContain('id="party-outcome-revision-party-1"');
  });

  it("stays quiet when there is no unissued revision", () => {
    expect(panel("en-CA", en, false)).not.toContain("An unissued revision is pending.");
  });
});
