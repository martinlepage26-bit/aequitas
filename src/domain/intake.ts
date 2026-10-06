/** Short dispute summary captured when a case is opened. */
export const DISPUTE_DESCRIPTION_MAX = 2000;
/** About 20 million CAD. Prisma stores this in a 32-bit integer column. */
export const AMOUNT_AT_STAKE_MAX_CENTS = 2_000_000_000;

export function normalizeDisputeDescription(
  value: unknown
): { ok: true; description: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "disputeDescription is required." };
  const description = value.trim();
  if (description.length === 0) return { ok: false, reason: "disputeDescription is required." };
  if (description.length > DISPUTE_DESCRIPTION_MAX) {
    return { ok: false, reason: `disputeDescription must be at most ${DISPUTE_DESCRIPTION_MAX} characters.` };
  }
  return { ok: true, description };
}

/**
 * Approximate amount at stake, in Canadian dollars. Omitted means unknown.
 * Values are rounded to the nearest cent.
 */
export function normalizeAmountAtStake(value: unknown): { ok: true; cents: number | null } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === "") return { ok: true, cents: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, reason: "amountAtStake must be a non-negative number of Canadian dollars, or omitted." };
  }
  const cents = Math.round(value * 100);
  if (!Number.isInteger(cents) || cents > AMOUNT_AT_STAKE_MAX_CENTS) {
    return { ok: false, reason: "amountAtStake is too large." };
  }
  return { ok: true, cents };
}

export function missingIntakeFields(row: { disputeDescription: string | null }): string[] {
  return row.disputeDescription && row.disputeDescription.trim().length > 0 ? [] : ["disputeDescription"];
}

export function assertStoredIntake(input: {
  disputeDescription: string;
  amountAtStakeCents?: number | null;
}): { ok: true; description: string; cents: number | null } | { ok: false; reason: string } {
  const description = normalizeDisputeDescription(input.disputeDescription);
  if (!description.ok) return description;
  const cents = input.amountAtStakeCents ?? null;
  if (cents !== null && (!Number.isInteger(cents) || cents < 0 || cents > AMOUNT_AT_STAKE_MAX_CENTS)) {
    return { ok: false, reason: "amountAtStake is too large." };
  }
  return { ok: true, description: description.description, cents };
}
