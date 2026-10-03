import { describe, expect, it } from "vitest";
import { chronologyInputSchema, formatChronologyDate, isCalendarDate } from "../../src/domain/chronology";
import { submissionAvailability } from "../../src/domain/submissionView";
import { replayCaseState } from "../../src/domain/replay";
import { buildKnowledgeSources } from "../../src/ai/prompts/conflictKnowledge";
import { buildDraftSystemPrompt, type DraftPromptInput } from "../../src/ai/prompts/draftRecommendation";

describe("party-reported chronology", () => {
  it.each(["2026-02-31", "2025-02-29", "0000-01-01", "2026-13-01", "2026-1-1", "not-a-date"])("rejects invalid date %s", value => {
    expect(isCalendarDate(value)).toBe(false);
  });
  it.each(["2024-02-29", "2026-01-01", "0099-01-01"])("accepts real calendar date %s", value => {
    expect(isCalendarDate(value)).toBe(true);
  });
  it("validates required text, limits and locale", () => {
    const input = { occurredOn: "2026-01-01", title: "  Message received  ", description: "  I received a message.  ", locale: "en-CA" };
    expect(chronologyInputSchema.parse(input).title).toBe("Message received");
    for (const patch of [{ title: " " }, { description: " " }, { title: "x".repeat(201) }, { description: "x".repeat(8001) }, { locale: "xx" }]) {
      expect(chronologyInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
  it("formats the reported date without converting to a local previous day", () => {
    expect(formatChronologyDate(new Date("2026-01-01T00:00:00Z"), "en-CA")).toContain("1");
    expect(formatChronologyDate(new Date("2026-01-01T00:00:00Z"), "fr-CA")).toContain("janv");
  });
  it("keeps audit-only chronology entries from advancing the case state", () => {
    expect(replayCaseState([{ type: "CASE_CREATED" }, { type: "EVIDENCE_INTAKE_OPENED" }, { type: "CHRONOLOGY_ENTRY_SUBMITTED" }])).toBe("EVIDENCE_INTAKE");
  });
  it("provides visible guidance at every stage without granting new permissions", () => {
    expect(submissionAvailability("chronology", "DRAFT", true)).toBe("submitCaseFirst");
    expect(submissionAvailability("evidence", "OPEN", true)).toBe("waitingForManager");
    expect(submissionAvailability("chronology", "EVIDENCE_INTAKE", true)).toBe("available");
    expect(submissionAvailability("position", "EVIDENCE_INTAKE", true)).toBe("afterEvidence");
    expect(submissionAvailability("chronology", "POSITIONS", true)).toBe("intakeClosed");
    expect(submissionAvailability("position", "POSITIONS", true)).toBe("available");
    expect(submissionAvailability("position", "CLOSED", true)).toBe("readOnly");
    expect(submissionAvailability("chronology", "EVIDENCE_INTAKE", false)).toBe("partiesOnly");
  });
  it("preserves date, author, locale and original words in the drafting source registry", () => {
    const input: DraftPromptInput = {
      locale: "fr-CA", category: "RETAIL", complainantEvidence: [], respondentEvidence: [], legalResearch: [],
      complainantPosition: { partyRole: "complainant", body: "My account." },
      respondentPosition: { partyRole: "respondent", body: "Another account." },
      chronology: [{ id: "event1", occurredOn: "2026-01-01", title: "Message reçu", description: "J'ai reçu le message.", locale: "fr-CA", submittedByRole: "complainant", createdAt: "2026-10-01T00:00:00.000Z" }],
    };
    expect(buildKnowledgeSources(input)[0]).toMatchObject({
      id: "chronology:event1", kind: "chronology", submitted_by_role: "complainant", locale: "fr-CA",
      created_at: "2026-10-01T00:00:00.000Z", fields: { description: "Reported date: 2026-01-01", body: "J'ai reçu le message." },
    });
    expect(buildDraftSystemPrompt("RETAIL")).toContain("not independently verified facts");
  });
});
