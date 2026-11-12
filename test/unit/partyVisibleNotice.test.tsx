import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import PartyVisibleNotice from "../../src/app/[locale]/cases/[caseId]/PartyVisibleNotice";
import en from "../../messages/en-CA.json";
import fr from "../../messages/fr-CA.json";

function notice(locale: string, messages: typeof en, partyName?: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <PartyVisibleNotice partyName={partyName} />
    </NextIntlClientProvider>,
  );
}

describe("PartyVisibleNotice", () => {
  it("tells the mediator that both parties may read the text, in English and French", () => {
    const english = notice("en-CA", en);
    const french = notice("fr-CA", fr).replaceAll("&#x27;", "'").replaceAll("&#39;", "'");
    expect(english).toContain("Both parties may read this text.");
    expect(english).toContain("Write only what both parties should see.");
    expect(french).toContain("Les deux parties peuvent lire ce texte.");
    expect(french).toContain("N'écrivez que ce que les deux parties doivent voir.");
    expect(english).toContain('role="note"');
    expect(french).toContain('role="note"');
  });

  it("scopes the notice to one party when the mediator writes that party's outcome", () => {
    const english = notice("en-CA", en, "Northwind");
    const french = notice("fr-CA", fr, "Northwind").replaceAll("&#x27;", "'").replaceAll("&#39;", "'");
    expect(english).toContain("Only Northwind can read this outcome. Write only what that party should see.");
    expect(french).toContain("Seul Northwind peut lire ce résultat. N'écrivez que ce que cette partie doit voir.");
    expect(english).not.toContain("Both parties may read this text.");
    expect(french).not.toContain("Les deux parties peuvent lire ce texte.");
  });
});
