/**
 * P7: the pipeline must not store an absolute claim. The same block covers
 * the terminology already banned in the message catalogs.
 */
const ABSOLUTE_CLAIM: RegExp[] = [
  /\bimpartial\b/i,
  /impartialit[ée]/i,
  /100\s*%\s*compliant/i,
  /pleinement conforme/i,
  /\bno bias\b/i,
  /sans biais/i,
  /aucun biais/i,
  /aucun parti pris/i,
  /neutral verdict/i,
  /verdict neutre/i,
  /bias was not detected/i,
  /aucun biais n'a été détecté/i,
  /\bdecision\b/i,
  /\bdécision\b/i,
  /\bscore\b/i,
];

export function absoluteClaimHit(text: string): string | null {
  for (const pattern of ABSOLUTE_CLAIM) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}
