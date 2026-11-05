import { describe, expect, it } from "vitest";
import { visiblePartyOutcomesForExport } from "../../src/domain/exportBundle";

describe("visiblePartyOutcomesForExport", () => {
  const rows = [
    { partyId: "complainant", status: "DRAFT", body: "COMPLAINANT-DRAFT" },
    { partyId: "complainant", status: "ISSUED", body: "COMPLAINANT-ISSUED" },
    { partyId: "respondent", status: "ISSUED", body: "RESPONDENT-ISSUED" },
  ];

  it("keeps only the viewer's issued outcomes", () => {
    expect(visiblePartyOutcomesForExport(rows, "complainant")).toEqual([
      { partyId: "complainant", status: "ISSUED", body: "COMPLAINANT-ISSUED" },
    ]);
  });
});
