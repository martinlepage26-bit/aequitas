import { createHash } from "node:crypto";
import { cfg } from "./config";

/**
 * Independent verifier. Deliberately shares no code with src/domain/events.ts or replay.ts: it implements the
 * formula published in the export's verification.txt, and a transition-legality table written from the spec.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(object[k])}`).join(",")}}`;
}

export interface ChainEvent { seq: number; type: string; actorId: string; payload: unknown; prevHash: string; hash: string; createdAt: Date | string }
export interface Issue { seq: number | null; message: string }
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);
export const eventHash = (e: ChainEvent, prevHash = e.prevHash) =>
  createHash("sha256").update(prevHash + canonicalJson(e.payload) + e.actorId + String(e.seq) + iso(e.createdAt), "utf8").digest("hex");

export function verifyChain(events: ChainEvent[], genesis = cfg.genesis): Issue[] {
  const issues: Issue[] = [];
  let prev = genesis, expectedSeq = 1, lastTime = 0;
  for (const e of events) {
    if (e.seq !== expectedSeq) issues.push({ seq: e.seq, message: `seq gap/duplicate: expected ${expectedSeq}` });
    if (e.prevHash !== prev) issues.push({ seq: e.seq, message: "prevHash does not match previous hash" });
    if (eventHash(e) !== e.hash) issues.push({ seq: e.seq, message: "hash does not match recomputation" });
    const t = new Date(iso(e.createdAt)).getTime();
    if (t < lastTime) issues.push({ seq: e.seq, message: "createdAt goes backwards" });
    lastTime = t; prev = e.hash; expectedSeq = e.seq + 1;
  }
  return issues;
}

type State = "DRAFT" | "OPEN" | "EVIDENCE_INTAKE" | "POSITIONS" | "DRAFTING" | "ISSUED" | "RESOLVED_CONSENT" | "RESOLVED_DECLINED" | "WITHDRAWN" | "CLOSED";
const NOT_CLOSED: Array<State | "NONE"> = ["DRAFT", "OPEN", "EVIDENCE_INTAKE", "POSITIONS", "DRAFTING", "ISSUED", "RESOLVED_CONSENT", "RESOLVED_DECLINED", "WITHDRAWN"];
const RULES: Record<string, { from: Array<State | "NONE">; to?: State | ((payload: any) => State) }> = {
  CASE_CREATED: { from: ["NONE"], to: "DRAFT" },
  CASE_SUBMITTED: { from: ["DRAFT"], to: "OPEN" },
  EVIDENCE_INTAKE_OPENED: { from: ["OPEN"], to: "EVIDENCE_INTAKE" },
  CASE_ASSIGNED: { from: ["EVIDENCE_INTAKE"] },
  EVIDENCE_SUBMITTED: { from: ["EVIDENCE_INTAKE"] },
  EVIDENCE_SUPERSEDED: { from: ["EVIDENCE_INTAKE"] },
  CHRONOLOGY_ENTRY_SUBMITTED: { from: ["EVIDENCE_INTAKE"] },
  EVIDENCE_INTAKE_CLOSED: { from: ["EVIDENCE_INTAKE"], to: "POSITIONS" },
  POSITION_SUBMITTED: { from: ["POSITIONS"] },
  RECOMMENDATION_DRAFT_REQUESTED: { from: ["POSITIONS", "DRAFTING", "ISSUED", "RESOLVED_DECLINED"], to: "DRAFTING" },
  RECOMMENDATION_DRAFT_FAILED: { from: ["DRAFTING"], to: (p) => (p?.toState === "DRAFTING" ? "DRAFTING" : "POSITIONS") },
  RECOMMENDATION_DRAFTED: { from: ["DRAFTING"] },
  RECOMMENDATION_ISSUED: { from: ["DRAFTING"], to: "ISSUED" },
  CONSENT_GIVEN: { from: ["ISSUED"] },
  CASE_RESOLVED: { from: ["ISSUED"], to: "RESOLVED_CONSENT" },
  CONSENT_DECLINED: { from: ["ISSUED"] },
  CASE_RESOLVED_DECLINED: { from: ["ISSUED"], to: "RESOLVED_DECLINED" },
  CONSENT_REVOKED: { from: ["ISSUED", "RESOLVED_CONSENT"] },
  CASE_REOPENED: { from: ["ISSUED", "RESOLVED_CONSENT"], to: "ISSUED" },
  CASE_WITHDRAWN: { from: NOT_CLOSED.filter((s) => s !== "NONE"), to: "WITHDRAWN" },
  EXPORT_GENERATED: { from: ["RESOLVED_CONSENT", "RESOLVED_DECLINED", "WITHDRAWN"] },
  CASE_CLOSED: { from: ["RESOLVED_CONSENT", "RESOLVED_DECLINED", "WITHDRAWN"], to: "CLOSED" },
};

/** Replays the log and reports every event that is not legal from the state the log had reached. */
export function legality(events: ChainEvent[]): { issues: Issue[]; finalState: State | "NONE" } {
  const issues: Issue[] = [];
  let state: State | "NONE" = "NONE";
  for (const e of events) {
    const rule = RULES[e.type];
    if (!rule) continue; // audit-only events never change state
    if (!rule.from.includes(state)) issues.push({ seq: e.seq, message: `${e.type} is not legal from ${state}` });
    if (rule.to) state = typeof rule.to === "function" ? rule.to(e.payload) : rule.to;
  }
  return { issues, finalState: state };
}
