import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, type PDFDict, type PDFPage, type PDFRef } from "pdf-lib";

export type PdfLanguage = "en-CA" | "fr-CA";
export type PdfTextRun = { text: string; language: PdfLanguage };
export type TaggedPdfElement = { ref: PDFRef; kids: PDFArray; role: "Document" | "H1" | "H2" | "H3" | "P" | "Span" };

/** ISO 32000 logical structure for our text-only reports. Every painted text
 * fragment has an MCID, an owning structure element, and a reverse ParentTree
 * entry. A paragraph may span pages without becoming unrelated line tags.
 * This is real tagging, not a PDF/UA conformance declaration. */
export class TaggedPdf {
  private readonly root: PDFDict;
  private readonly rootRef: PDFRef;
  readonly document: TaggedPdfElement;
  private readonly pages = new Map<PDFPage, { key: number; parents: PDFArray }>();

  constructor(private readonly doc: PDFDocument) {
    this.root = doc.context.obj({ Type: "StructTreeRoot" });
    this.rootRef = doc.context.register(this.root);
    this.document = this.createElement("Document", this.rootRef, "fr-CA");
    this.root.set(PDFName.of("K"), doc.context.obj([this.document.ref]));
    doc.catalog.set(PDFName.of("StructTreeRoot"), this.rootRef);
    doc.catalog.set(PDFName.of("MarkInfo"), doc.context.obj({ Marked: true }));
    doc.catalog.getOrCreateViewerPreferences().setDisplayDocTitle(true);
  }

  private createElement(role: TaggedPdfElement["role"], parent: PDFRef, language?: PdfLanguage): TaggedPdfElement {
    const kids = this.doc.context.obj([]);
    const dictionary = this.doc.context.obj({ Type: "StructElem", S: role, P: parent, K: kids });
    if (language) dictionary.set(PDFName.of("Lang"), PDFHexString.fromText(language));
    return { ref: this.doc.context.register(dictionary), kids, role };
  }

  element(role: Exclude<TaggedPdfElement["role"], "Document">, parent = this.document, language?: PdfLanguage): TaggedPdfElement {
    const element = this.createElement(role, parent.ref, language);
    parent.kids.push(element.ref);
    return element;
  }

  page(page: PDFPage): void {
    if (this.pages.has(page)) return;
    const key = this.pages.size;
    this.pages.set(page, { key, parents: this.doc.context.obj([]) });
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(key));
    page.node.set(PDFName.of("Tabs"), PDFName.of("S"));
  }

  content(page: PDFPage, parent: TaggedPdfElement, draw: () => void): void {
    this.page(page);
    const record = this.pages.get(page)!;
    const mcid = record.parents.size();
    record.parents.push(parent.ref);
    parent.kids.push(this.doc.context.obj({ Type: "MCR", Pg: page.ref, MCID: mcid }));
    // pdf-lib's public operator argument type lacks PDFDict, but supports a
    // serialized operator argument. Only our generated integer is interpolated.
    page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(parent.role), `<< /MCID ${mcid} >>`]));
    draw();
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  }

  finish(): void {
    const nums = this.doc.context.obj([]);
    for (const { key, parents } of this.pages.values()) {
      nums.push(PDFNumber.of(key));
      nums.push(parents);
    }
    this.root.set(PDFName.of("ParentTree"), this.doc.context.register(this.doc.context.obj({ Nums: nums })));
    this.root.set(PDFName.of("ParentTreeNextKey"), PDFNumber.of(this.pages.size));
  }
}

export function pdfLanguage(value?: string): PdfLanguage { return value?.startsWith("en") ? "en-CA" : "fr-CA"; }
export function en(text: string): PdfTextRun { return { text, language: "en-CA" }; }
export function fr(text: string): PdfTextRun { return { text, language: "fr-CA" }; }
export function bilingual(enText: string, frText: string, suffix = "", language: PdfLanguage = "fr-CA"): PdfTextRun[] {
  return [en(`${enText} / `), fr(frText), ...(suffix ? [{ text: suffix, language }] : [])];
}

/** Wrap while retaining the language run owning every character. Break long
 * identifiers without inserting spaces into their source text. */
export function wrapPdfRuns(runs: readonly PdfTextRun[], width: (text: string) => number, maxWidth: number): Array<Array<{ text: string; run: number }>> {
  const characters: Array<{ text: string; run: number }> = [];
  for (let run = 0; run < runs.length; run++) {
    for (const character of Array.from(runs[run].text)) {
      if (/\s/u.test(character)) {
        if (characters.length && characters.at(-1)!.text !== " ") characters.push({ text: " ", run });
      } else characters.push({ text: character, run });
    }
  }
  while (characters.at(-1)?.text === " ") characters.pop();
  const group = (slice: typeof characters) => {
    const fragments: Array<{ text: string; run: number }> = [];
    for (const character of slice) {
      const previous = fragments.at(-1);
      if (previous?.run === character.run) previous.text += character.text;
      else fragments.push({ ...character });
    }
    return fragments;
  };
  const lines: ReturnType<typeof wrapPdfRuns> = [];
  let start = 0;
  while (start < characters.length) {
    let end = start, lastSpace = -1;
    while (end < characters.length) {
      const candidate = group(characters.slice(start, end + 1));
      if (candidate.reduce((total, fragment) => total + width(fragment.text), 0) > maxWidth && end > start) break;
      if (characters[end].text === " ") lastSpace = end;
      end++;
    }
    if (end < characters.length && lastSpace > start) end = lastSpace;
    const line = characters.slice(start, end);
    while (line.at(-1)?.text === " ") line.pop();
    if (line.length) lines.push(group(line));
    start = end;
    while (characters[start]?.text === " ") start++;
  }
  return lines;
}
