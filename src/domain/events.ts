import { createHash } from "node:crypto";
import type { Prisma, EventType } from "../generated/prisma";

const GENESIS_HASH = process.env.HASH_CHAIN_GENESIS ?? "0".repeat(64);

/**
 * Deterministic JSON serialization: object keys sorted recursively, no
 * whitespace. Array order is preserved (arrays are ordered data, not sets).
 * Section 8: "Canonical JSON = sorted keys, no whitespace, UTF-8."
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export interface HashChainInput {
  prevHash: string;
  payload: unknown;
  actorId: string;
  seq: number;
  createdAtIso: string;
}

/**
 * Section 8: hash = SHA256(prev_hash || canonical_json(payload) || actorId || seq || createdAt_iso)
 * `||` is concatenation, not a delimiter — matched literally so the formula
 * is reproducible by an independent verifier following the spec text.
 */
export function computeEventHash({ prevHash, payload, actorId, seq, createdAtIso }: HashChainInput): string {
  const input = prevHash + canonicalJson(payload) + actorId + String(seq) + createdAtIso;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface AppendEventInput {
  caseId: string;
  type: EventType;
  actorId: string;
  payload: unknown;
}

/**
 * Appends one event to a case's chain. Must be called with a transaction
 * client so the event write is atomic with the domain row write that
 * caused it (guardrail 1). Computes seq and prevHash from the case's
 * current chain tip, so callers never supply them directly.
 */
export async function appendEvent(tx: Prisma.TransactionClient, input: AppendEventInput) {
  // All chain writers, including read-access audits, serialize on the case row.
  await tx.$queryRaw`SELECT id FROM "Case" WHERE id = ${input.caseId} FOR UPDATE`;
  const tip = await tx.event.findFirst({
    where: { caseId: input.caseId },
    orderBy: { seq: "desc" },
    select: { seq: true, hash: true },
  });

  const seq = (tip?.seq ?? 0) + 1;
  const prevHash = tip?.hash ?? GENESIS_HASH;
  const createdAtIso = new Date().toISOString();
  const hash = computeEventHash({ prevHash, payload: input.payload, actorId: input.actorId, seq, createdAtIso });

  return tx.event.create({
    data: {
      caseId: input.caseId,
      seq,
      type: input.type,
      actorId: input.actorId,
      payload: input.payload as Prisma.InputJsonValue,
      prevHash,
      hash,
      createdAt: new Date(createdAtIso),
    },
  });
}

export { GENESIS_HASH };
