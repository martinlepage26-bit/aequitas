import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import ConsentPanel from "../../src/app/[locale]/cases/[caseId]/ConsentPanel";
import en from "../../messages/en-CA.json";
import fr from "../../messages/fr-CA.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

function panel(locale: string, messages: typeof en, outcomeIssued: boolean, outcomeNeedsAnswer = false, outcome: { id: string; version: number } | null = outcomeIssued ? { id: "outcome-1", version: 1 } : null): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <ConsentPanel caseId="case-1" statementVersionId="statement-1" statementBody="The statement." ownConsentState="NOT_GIVEN" outcomeIssued={outcomeIssued} outcomeId={outcome?.id ?? null} outcomeVersion={outcome?.version ?? null} outcomeNeedsAnswer={outcomeNeedsAnswer} />
    </NextIntlClientProvider>,
  );
}

describe("party consent follows the issued outcome", () => {
  it("disables consent and decline until that party's outcome is issued, in English and French", () => {
    const english = panel("en-CA", en, false);
    const french = panel("fr-CA", fr, false).replaceAll("&#x27;", "'").replaceAll("&#39;", "'");
    expect(english).toContain("Outcome not yet available to you");
    expect(french).toContain("Le résultat ne vous est pas encore accessible.");
    expect(english).toMatch(/id="give-consent"[^>]*disabled/);
    expect(english).toMatch(/id="decline-consent"[^>]*disabled/);
    expect(french).toMatch(/id="give-consent"[^>]*disabled/);
    expect(french).toMatch(/id="decline-consent"[^>]*disabled/);
    expect(en.workspace.resolution.code.RESOLUTION_PAUSED).toBe("Resolution paused pending review");
    expect(fr.workspace.resolution.code.RESOLUTION_PAUSED).toBe("Règlement suspendu en attendant l'examen.");
  });

  it("enables consent and decline once that party's outcome is issued", () => {
    const english = panel("en-CA", en, true);
    const french = panel("fr-CA", fr, true);
    expect(english).not.toContain("Outcome not yet available to you");
    expect(french).not.toContain("Le résultat ne vous est pas encore accessible.");
    expect(english).not.toMatch(/id="give-consent"[^>]*disabled/);
    expect(english).not.toMatch(/id="decline-consent"[^>]*disabled/);
    expect(english).toContain('id="give-consent"');
    expect(english).toContain('data-outcome-id="outcome-1"');
    expect(english).toContain('data-outcome-version="1"');
    expect(french).toContain('id="decline-consent"');
  });

  it("names the superseded outcome in English and French", () => {
    expect(en.workspace.consent.outcomeSuperseded).toBe("A new outcome was issued, please review it.");
    expect(fr.workspace.consent.outcomeSuperseded).toBe("Un nouveau résultat a été émis, veuillez le relire.");
  });

  it("tells the party, in English and French, that a re-issued outcome needs a new answer", () => {
    const english = panel("en-CA", en, true, true);
    const french = panel("fr-CA", fr, true, true);
    expect(english).toContain("A new outcome needs your answer.");
    expect(french).toContain("Un nouveau résultat demande votre réponse.");
    expect(english).toMatch(/id="give-consent"[^>]*/);
    expect(english).not.toMatch(/id="give-consent"[^>]*disabled/);
  });
});
