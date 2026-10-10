export function excerptIsVerbatim(excerpt: string, sourceBody: string | null | undefined): boolean {
  const needle = excerpt.trim();
  if (!needle || !sourceBody) return false;
  return sourceBody.includes(needle);
}
