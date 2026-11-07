import { createHash } from "node:crypto";
import type { PartyOutcomeCitation } from "../generated/prisma";
import { canonicalJson } from "./events";

export type PartyOutcomeCitationPointer = Pick<
  PartyOutcomeCitation,
  | "evidenceItemId"
  | "relevance"
  | "startChar"
  | "endChar"
  | "sourceSha256"
  | "extractedTextSha256"
  | "extractionMethod"
>;

/** Stable digest bound into PARTY_OUTCOME_ISSUED for audit verification. */
export function digestPartyOutcomeCitations(citations: readonly PartyOutcomeCitationPointer[]): string {
  // Persisted Prisma rows also contain ids and timestamps. Bind only the
  // outcome citation fields so the digest is identical before and after save.
  const ordered = citations.map((citation) => ({
    evidenceItemId: citation.evidenceItemId,
    relevance: citation.relevance,
    startChar: citation.startChar,
    endChar: citation.endChar,
    sourceSha256: citation.sourceSha256,
    extractedTextSha256: citation.extractedTextSha256,
    extractionMethod: citation.extractionMethod,
  })).sort((a, b) => a.evidenceItemId.localeCompare(b.evidenceItemId));
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}
