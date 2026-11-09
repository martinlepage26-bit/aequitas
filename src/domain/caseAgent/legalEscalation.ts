/**
 * A conservative, local-only backstop for explicit legal concepts and requests.
 * This is not a legal classifier: implicit issues can still be missed and
 * must also be handled by the model's handoff instruction.
 */
const EXPLICIT_LEGAL_MARKERS: readonly RegExp[] = [
  /\b(?:legal advice|legal interpretation|legal rights?|legally entitled|statutory warranty|statutory rights?|consumer protection (?:law|act))\b/u,
  /\b(?:under|according to)\b.{0,80}\b(?:law|statute|act|statutory warranty)\b/u,
  /\b(?:law|statute|act)\b.{0,80}\b(?:apply|applies|cover|covers|entitle|entitled|require|requires)\b/u,
  /\b(?:loi sur la protection du consommateur|garantie legale|avis juridique|conseil juridique|interpretation juridique|droits? legaux?)\b/u,
  /\b(?:en vertu de|selon)\b.{0,80}\b(?:la )?(?:loi|garantie legale)\b/u,
  /\b(?:loi|garantie legale)\b.{0,80}\b(?:s'applique|couvre|oblige|exige)\b/u,
];

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").replace(/[’‘]/gu, "'").toLowerCase();
}

/** True when supplied text contains an explicit legal marker or request. */
export function hasExplicitLegalIssueMarker(texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((text) => {
    if (!text) return false;
    const value = normalize(text);
    return EXPLICIT_LEGAL_MARKERS.some((marker) => marker.test(value));
  });
}
