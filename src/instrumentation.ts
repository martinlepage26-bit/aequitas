/** A restored database cannot serve before independent erasure tombstones
 * have been reconciled. No provider calls or content logging during startup. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.RETENTION_ENFORCEMENT_ENABLED === "true") {
    const { assertRetentionRestoreSafe } = await import("./domain/retentionLedger");
    await assertRetentionRestoreSafe();
  }
}
