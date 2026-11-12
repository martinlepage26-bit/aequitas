/** Measured review defaults selected by the owner; no automatic permission to
 * erase real records and no assertion that this is a universal legal period. */
export const RETENTION_POLICY_VERSION = "measured-review-2026-11-12-v1";
export const EXTERNAL_COPY_STORES = ["DATABASE_BACKUPS", "OBJECT_SNAPSHOTS", "PARSER_SCRATCH", "APPLICATION_LOGS", "EMAIL_PROVIDER", "MODEL_PROVIDER", "DOWNLOADED_EXPORTS", "EXTERNAL_REFERENCES"] as const;

export function retentionReviewAt(closedAt: Date): Date {
  const next = new Date(closedAt);
  next.setUTCFullYear(closedAt.getUTCFullYear() + 1);
  // First calendar anniversary of leap day is February 28.
  if (next.getUTCMonth() !== closedAt.getUTCMonth()) next.setUTCDate(0);
  return next;
}
