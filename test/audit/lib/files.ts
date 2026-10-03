import { PDFDocument, StandardFonts } from "pdf-lib";

/** Synthetic evidence payloads. No real documents or personal data. */
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const png = () => Buffer.from(PNG_1x1);
/** A valid PNG followed by zero padding (ignored after IEND) so size limits can be probed with a sniffable file. */
export const pngOfSize = (bytes: number) => Buffer.concat([PNG_1x1, Buffer.alloc(Math.max(0, bytes - PNG_1x1.length))]);
export const text = (body = "Synthetic message: the invoice was received on the stated date.\n") => Buffer.from(body, "utf8");
export const textOfSize = (bytes: number) => Buffer.from("a".repeat(bytes), "utf8");
export const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
export const exe = () => Buffer.concat([Buffer.from("MZ"), Buffer.alloc(62), Buffer.from("PE\0\0"), Buffer.alloc(200)]);
export const unsniffable = () => Buffer.from([0x01, 0x02, 0x03, 0x04, 0x80, 0x81, 0x82, 0x00, 0xff, 0xfe, 0x00, 0x7f]);
/** The standard EICAR antivirus test string, assembled from parts so this source file is not itself an AV hit. */
export const eicar = () => Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "ascii");
export async function pdf(lines: string[] = ["Synthetic evidence page"]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  lines.forEach((line, i) => page.drawText(line, { x: 20, y: 160 - i * 16, size: 12, font }));
  return Buffer.from(await doc.save());
}

export function evidenceForm(file: Buffer, opts: { kind?: string; title?: string; description?: string; filename?: string; type?: string } = {}) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(file)], opts.filename ?? "evidence.bin", { type: opts.type ?? "application/octet-stream" }));
  if (opts.kind !== null) form.set("kind", opts.kind ?? "DOCUMENT");
  if (opts.title !== null) form.set("title", opts.title ?? "Synthetic evidence");
  if (opts.description) form.set("description", opts.description);
  return form;
}
