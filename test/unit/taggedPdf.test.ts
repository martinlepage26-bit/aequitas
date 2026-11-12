import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildExportPdf } from "../../src/domain/exportBundle";
import { bilingual, en, wrapPdfRuns } from "../../src/lib/taggedPdf";

const now = "2026-11-12T00:00:00.000Z";
const french = "Début du récit. " + "Cette phrase préserve les accents, les faits rapportés et leur ordre. ".repeat(180) + "Fin du récit.";
const english = "An English account follows the complete French account.";
function fixture(): Parameters<typeof buildExportPdf>[0] {
  const party = { id: "synthetic", displayName: "Personne fictive", email: "synthetic@example.com", locale: "fr-CA" };
  return {
    exportedAt: now,
    case: { id: "synthetic", referenceNumber: "ACCESSIBLE-SYNTHETIC", category: "EMPLOYMENT", disputeDescription: "Résumé fictif.", amountAtStakeCents: 1000, state: "CLOSED", simulated: true, createdAt: now, closedAt: now },
    parties: { complainant: party, respondent: { ...party, id: "respondent", locale: "en-CA" }, caseManager: null },
    timeline: [], evidence: [], chronology: [], consent: [], recommendations: [],
    positions: [
      { id: "fr", partyId: party.id, partyName: party.displayName, body: french, locale: "fr-CA", version: 1, createdAt: now },
      { id: "en", partyId: "respondent", partyName: "Synthetic participant", body: english, locale: "en-CA", version: 1, createdAt: now },
    ],
  };
}
function name(dict: PDFDict, key: string) { return dict.lookup(PDFName.of(key), PDFName).decodeText(); }
function contentStreams(doc: PDFDocument, page: ReturnType<PDFDocument["getPages"]>[number]) {
  const value = page.node.lookup(PDFName.of("Contents"));
  const streams = value instanceof PDFArray ? value.asArray() : [value];
  return streams.map(stream => {
    const object = doc.context.lookup(stream);
    if (!(object instanceof PDFRawStream)) throw new Error("Expected a PDF content stream");
    return Buffer.from(decodePDFRawStream(object).decode()).toString("utf8");
  }).join("\n");
}

describe("tagged bilingual PDF exports", () => {
  it.each([false, true])("owns every text fragment in a bidirectionally linked structure tree (party view=%s)", async partyView => {
    const bytes = await buildExportPdf(fixture(), { partyView });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(3);
    expect(doc.getTitle()).toBe("Aequitas — ACCESSIBLE-SYNTHETIC");
    expect(doc.catalog.lookup(PDFName.of("Lang"), PDFString).decodeText()).toBe("fr-CA");
    expect(doc.catalog.lookup(PDFName.of("MarkInfo"), PDFDict).lookup(PDFName.of("Marked"), PDFBool).asBoolean()).toBe(true);
    expect(doc.catalog.lookup(PDFName.of("ViewerPreferences"), PDFDict).lookup(PDFName.of("DisplayDocTitle"), PDFBool).asBoolean()).toBe(true);
    const rootRef = doc.catalog.get(PDFName.of("StructTreeRoot")) as PDFRef;
    const root = doc.context.lookup(rootRef, PDFDict);
    const parentNums = root.lookup(PDFName.of("ParentTree"), PDFDict).lookup(PDFName.of("Nums"), PDFArray);
    const parents = new Map<number, PDFArray>();
    for (let i = 0; i < parentNums.size(); i += 2) parents.set(parentNums.lookup(i, PDFNumber).asNumber(), parentNums.lookup(i + 1, PDFArray));
    expect(parents.size).toBe(doc.getPageCount());
    const pageByRef = new Map(doc.getPages().map(page => [page.ref.toString(), page]));
    const owned = new Map<string, string>();
    const roles: string[] = [];
    const languages: string[] = [];
    const spanningElements: Set<string>[] = [];
    const walk = (ref: PDFRef, parent: PDFRef): Set<string> => {
      const element = doc.context.lookup(ref, PDFDict);
      expect(name(element, "Type")).toBe("StructElem");
      expect(element.get(PDFName.of("P"))?.toString()).toBe(parent.toString());
      const role = name(element, "S");
      roles.push(role);
      if (element.has(PDFName.of("Lang"))) languages.push(element.lookup(PDFName.of("Lang"), PDFHexString).decodeText());
      const pages = new Set<string>();
      for (const child of element.lookup(PDFName.of("K"), PDFArray).asArray()) {
        if (child instanceof PDFRef) {
          for (const page of walk(child, ref)) pages.add(page);
          continue;
        }
        expect(child).toBeInstanceOf(PDFDict);
        const mcr = child as PDFDict;
        expect(name(mcr, "Type")).toBe("MCR");
        const pageRef = mcr.get(PDFName.of("Pg"))!.toString();
        const page = pageByRef.get(pageRef)!;
        expect(page).toBeDefined();
        const mcid = mcr.lookup(PDFName.of("MCID"), PDFNumber).asNumber();
        const pageKey = page.node.lookup(PDFName.of("StructParents"), PDFNumber).asNumber();
        const key = `${pageRef}:${mcid}`;
        expect(owned.has(key)).toBe(false);
        owned.set(key, ref.toString());
        expect(parents.get(pageKey)!.get(mcid).toString()).toBe(ref.toString());
        pages.add(pageRef);
      }
      if (role === "P") spanningElements.push(pages);
      return pages;
    };
    for (const child of root.lookup(PDFName.of("K"), PDFArray).asArray()) walk(child as PDFRef, rootRef);
    expect(roles[0]).toBe("Document");
    expect(roles.filter(role => role === "H1")).toHaveLength(1);
    expect(roles.filter(role => role === "H2").length).toBeGreaterThanOrEqual(9);
    expect(new Set(languages)).toEqual(new Set(["en-CA", "fr-CA"]));
    expect(spanningElements.some(pages => pages.size > 1)).toBe(true);
    const encountered: string[] = [];
    for (const page of doc.getPages()) {
      expect(name(page.node, "Tabs")).toBe("S");
      const content = contentStreams(doc, page);
      let current: number | null = null;
      let paints = 0;
      for (const line of content.split("\n")) {
        const begin = line.match(/^\/Span << \/MCID (\d+) >> BDC$/);
        if (begin) { expect(current).toBeNull(); current = Number(begin[1]); encountered.push(`${page.ref}:${current}`); }
        if (/\b(?:Tj|TJ)$/.test(line)) { expect(current).not.toBeNull(); paints++; }
        if (line === "EMC") { expect(current).not.toBeNull(); current = null; }
      }
      expect(current).toBeNull();
      expect(paints).toBeGreaterThan(0);
    }
    expect(new Set(encountered).size).toBe(encountered.length);
    expect(new Set(encountered)).toEqual(new Set(owned.keys()));
  }, 30000);

  it("exposes French then English text through an independent structure reader and keeps accents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aequitas-tagged-pdf-"));
    try {
      const path = join(directory, "synthetic.pdf");
      await writeFile(path, await buildExportPdf(fixture()));
      const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
      expect(info).toMatch(/Tagged:\s+yes/);
      const structure = execFileSync("pdfinfo", ["-struct-text", path], { encoding: "utf8" });
      expect(structure).toContain("H1");
      expect(structure).toContain("H2");
      expect(structure).toContain("Début du récit.");
      expect(structure).toContain("Fin du récit.");
      expect(structure).toContain(english);
      expect(structure.indexOf("Début du récit.")).toBeLessThan(structure.indexOf("Fin du récit."));
      expect(structure.indexOf("Fin du récit.")).toBeLessThan(structure.indexOf(english));
      const text = execFileSync("pdftotext", [path, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
      expect(text).toContain(french);
      expect(text).toContain(english);
      expect(text).toContain("Déclarations de position");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);

  it("wraps language runs without changing ownership or inserting characters into long identifiers", () => {
    const input = [...bilingual("English", "Français"), en(" ABCDEFGHIJKLMNOPQRSTUVWXYZ")];
    const lines = wrapPdfRuns(input, text => text.length, 10);
    expect(lines.flat().map(fragment => fragment.text).join("")).toBe("English /FrançaisABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(lines.every(line => line.reduce((n, fragment) => n + fragment.text.length, 0) <= 10)).toBe(true);
    expect(lines.flat().filter(fragment => fragment.run === 1).map(fragment => fragment.text).join("")).toBe("Français");
  });
});
