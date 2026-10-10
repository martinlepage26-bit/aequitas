import { z } from "zod";
import type { GlobalRole, Prisma } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { caseReadAccess, type CaseReadAccess } from "./caseAccess";
import { appendEvent } from "./events";
import type { MutationOutcome } from "./mutate";
import {
  CLAIM_CONFIDENCE,
  CLAIM_STATUSES,
  CLAIM_TYPES,
  LINK_PREDICATES,
  RELATION_PREDICATES,
  buildClaimsView,
  type ClaimRecord,
  type ClaimsView,
  type LinkRecord,
  type RelationshipRecord,
  type SourceRecord,
} from "./claimPresentation";

/**
 * Who may author traceable-core records. The reviewer role in the handoff
 * is the case manager assigned to the case. Administrators can read a case
 * and still cannot author claims. Parties can read claims and provenance.
 */
export function claimWritePermission(input: {
  access: CaseReadAccess | null;
  globalRole: GlobalRole;
}): { ok: true } | { ok: false; step: "authorize-role" | "not-found"; reason: string } {
  if (!input.access) return { ok: false, step: "not-found", reason: "Case not found." };
  if (input.globalRole === "ADMIN" || input.access === "admin") {
    return { ok: false, step: "authorize-role", reason: "Administrators cannot author claims, sources, links, relationships, or reviews." };
  }
  if (input.access === "party") {
    return { ok: false, step: "authorize-role", reason: "Only the case manager assigned to this case can author claims." };
  }
  if (input.access === "claimable") {
    return { ok: false, step: "authorize-role", reason: "Only the case manager assigned to this case can author claims." };
  }
  if (input.access === "assigned-manager" && input.globalRole === "CASE_MANAGER") return { ok: true };
  return { ok: false, step: "not-found", reason: "Case not found." };
}

export function claimReadPermission(access: CaseReadAccess | null): boolean {
  return access === "party" || access === "assigned-manager" || access === "admin" || access === "claimable";
}

const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

export const sourceInputSchema = z.object({
  kind: z.enum(["DOCUMENT", "MESSAGE", "TESTIMONY", "POLICY", "RECORD", "URL", "EVIDENCE_ITEM", "STATUTE"]),
  title: z.string().trim().min(1).max(300),
  origin: optionalText(500),
  obtainedVia: optionalText(500),
  language: z.string().trim().min(2).max(16).optional(),
  sensitive: z.boolean().optional(),
  visibility: z.enum(["CASE", "RESTRICTED", "REDACTED"]).optional(),
  citation: optionalText(500),
  legalFramework: optionalText(300),
  body: optionalText(20000),
  evidenceItemId: z.string().uuid().optional().nullable(),
  rationale: optionalText(2000),
});

export const claimInputSchema = z.object({
  claimType: z.enum(CLAIM_TYPES),
  text: z.string().trim().min(1).max(4000),
  confidence: z.enum(CLAIM_CONFIDENCE),
  confidenceRationale: optionalText(4000),
  locale: z.enum(["fr-CA", "en-CA"]),
  rationale: optionalText(2000),
});

export const claimPatchSchema = z.object({
  claimType: z.enum(CLAIM_TYPES).optional(),
  text: z.string().trim().min(1).max(4000).optional(),
  confidence: z.enum(CLAIM_CONFIDENCE).optional(),
  confidenceRationale: optionalText(4000),
  status: z.enum(CLAIM_STATUSES).optional(),
  mergedIntoId: z.string().uuid().nullable().optional(),
  rationale: optionalText(2000),
});

export const linkInputSchema = z.object({
  sourceId: z.string().uuid(),
  predicate: z.enum(LINK_PREDICATES),
  excerpt: z.string().trim().min(1).max(8000),
  rationale: optionalText(2000),
});

export const relationshipInputSchema = z.object({
  fromClaimId: z.string().uuid(),
  toClaimId: z.string().uuid(),
  predicate: z.enum(RELATION_PREDICATES),
  evidenceId: z.string().uuid().optional().nullable(),
  rationale: optionalText(2000),
}).refine((value) => value.fromClaimId !== value.toClaimId, { message: "A relationship connects two different claims." });

export const reviewInputSchema = z.object({
  claimId: z.string().uuid().optional().nullable(),
  action: z.enum(["NOTED", "EDITED", "APPROVED", "REJECTED", "OVERRULED_CONTESTATION"]),
  rationale: optionalText(4000),
});

export interface ActorInput {
  actorId: string;
  actorRole: GlobalRole;
  caseId: string;
}

function guard(reason: string): MutationOutcome<never> {
  return { ok: false, step: "guard", reason };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function requiresRationale(confidence: string, rationale: string | null): boolean {
  return (confidence === "DISPUTED" || confidence === "UNKNOWN") && !rationale;
}

async function authorizeWrite(input: ActorInput) {
  const caseRow = await prisma.case.findUnique({ where: { id: input.caseId } });
  if (!caseRow) return { ok: false as const, step: "not-found" as const, reason: "Case not found." };
  const access = caseReadAccess(caseRow, { userId: input.actorId, globalRole: input.actorRole });
  const permission = claimWritePermission({ access, globalRole: input.actorRole });
  if (!permission.ok) return permission;
  return { ok: true as const, caseRow };
}

export async function recordSource(input: ActorInput & z.infer<typeof sourceInputSchema>): Promise<MutationOutcome<{ id: string }>> {
  const parsed = sourceInputSchema.safeParse(input);
  if (!parsed.success) return guard("A source needs a kind and a title.");
  if (parsed.data.kind === "STATUTE" && !blankToNull(parsed.data.citation)) {
    return guard("A statute or legal-framework source requires a citation.");
  }
  if (parsed.data.kind === "EVIDENCE_ITEM" && !parsed.data.evidenceItemId) {
    return guard("An evidence-item source must reference an evidence item on this case.");
  }
  const auth = await authorizeWrite(input);
  if (!auth.ok) return auth;

  try {
    const id = await prisma.$transaction(async (tx) => {
      if (parsed.data.evidenceItemId) {
        const evidence = await tx.evidenceItem.findFirst({ where: { id: parsed.data.evidenceItemId, caseId: input.caseId }, select: { id: true } });
        if (!evidence) throw new Error("evidence-not-on-case");
      }
      const source = await tx.source.create({
        data: {
          caseId: input.caseId,
          kind: parsed.data.kind,
          title: parsed.data.title,
          origin: blankToNull(parsed.data.origin),
          obtainedVia: blankToNull(parsed.data.obtainedVia),
          language: parsed.data.language?.trim() || "fr-CA",
          sensitive: parsed.data.sensitive ?? false,
          visibility: parsed.data.visibility ?? "CASE",
          citation: blankToNull(parsed.data.citation),
          legalFramework: blankToNull(parsed.data.legalFramework),
          body: blankToNull(parsed.data.body),
          evidenceItemId: parsed.data.evidenceItemId ?? null,
          createdById: input.actorId,
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "SOURCE_RECORDED",
        actorId: input.actorId,
        payload: {
          sourceId: source.id,
          kind: source.kind,
          title: source.title,
          evidenceItemId: source.evidenceItemId,
          citation: source.citation,
          legalFramework: source.legalFramework,
          hasBody: Boolean(source.body?.trim()),
          rationale: blankToNull(parsed.data.rationale),
        },
      });
      return source.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "evidence-not-on-case") {
      return guard("That evidence item is not on this case.");
    }
    throw error;
  }
}

export async function recordClaim(input: ActorInput & z.infer<typeof claimInputSchema>): Promise<MutationOutcome<{ id: string }>> {
  const parsed = claimInputSchema.safeParse(input);
  if (!parsed.success) return guard("A claim needs a type, text, confidence, and locale.");
  const confidenceRationale = blankToNull(parsed.data.confidenceRationale);
  if (requiresRationale(parsed.data.confidence, confidenceRationale)) {
    return guard("A disputed or unknown claim needs a rationale naming what is missing.");
  }
  const auth = await authorizeWrite(input);
  if (!auth.ok) return auth;

  const id = await prisma.$transaction(async (tx) => {
    const claim = await tx.claim.create({
      data: {
        caseId: input.caseId,
        claimType: parsed.data.claimType,
        text: parsed.data.text,
        confidence: parsed.data.confidence,
        confidenceRationale,
        status: "NEEDS_EVIDENCE",
        locale: parsed.data.locale,
        doNotSummarizeAsSettled: parsed.data.claimType === "IMPACT_STATEMENT",
        createdById: input.actorId,
      },
    });
    await appendEvent(tx, {
      caseId: input.caseId,
      type: "CLAIM_RECORDED",
      actorId: input.actorId,
      payload: {
        claimId: claim.id,
        claimType: claim.claimType,
        status: claim.status,
        confidence: claim.confidence,
        rationale: blankToNull(parsed.data.rationale),
      },
    });
    return claim.id;
  });
  return { ok: true, data: { id } };
}

export async function updateClaim(input: ActorInput & { claimId: string } & z.infer<typeof claimPatchSchema>): Promise<MutationOutcome<{ id: string }>> {
  const parsed = claimPatchSchema.safeParse(input);
  if (!parsed.success) return guard("The claim update is not valid.");
  const auth = await authorizeWrite(input);
  if (!auth.ok) return auth;

  try {
    const id = await prisma.$transaction(async (tx) => {
      const current = await tx.claim.findFirst({ where: { id: input.claimId, caseId: input.caseId, deletedAt: null } });
      if (!current) throw new Error("claim-not-on-case");
      const nextConfidence = parsed.data.confidence ?? current.confidence;
      const nextRationale = parsed.data.confidenceRationale === undefined ? current.confidenceRationale : blankToNull(parsed.data.confidenceRationale);
      if (requiresRationale(nextConfidence, nextRationale)) {
        throw new Error("rationale-required");
      }
      const nextStatus = parsed.data.status ?? current.status;
      const links = await tx.claimEvidenceLink.findMany({ where: { claimId: current.id, deletedAt: null }, select: { excerpt: true } });
      const hasVerbatim = links.some((link) => link.excerpt.trim().length > 0);
      if (nextStatus !== "NEEDS_EVIDENCE" && !hasVerbatim) throw new Error("needs-excerpt");
      let mergedIntoId = parsed.data.mergedIntoId === undefined ? current.mergedIntoId : parsed.data.mergedIntoId;
      if (nextStatus === "MERGED") {
        if (!mergedIntoId || mergedIntoId === current.id) throw new Error("merge-target");
        const target = await tx.claim.findFirst({ where: { id: mergedIntoId, caseId: input.caseId, deletedAt: null }, select: { id: true } });
        if (!target) throw new Error("merge-target");
      }
      const nextType = parsed.data.claimType ?? current.claimType;
      const claim = await tx.claim.update({
        where: { id: current.id },
        data: {
          claimType: nextType,
          text: parsed.data.text ?? current.text,
          confidence: nextConfidence,
          confidenceRationale: nextRationale,
          status: nextStatus,
          mergedIntoId,
          doNotSummarizeAsSettled: nextType === "IMPACT_STATEMENT" ? true : current.doNotSummarizeAsSettled,
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "CLAIM_UPDATED",
        actorId: input.actorId,
        payload: {
          claimId: claim.id,
          claimType: claim.claimType,
          status: claim.status,
          confidence: claim.confidence,
          mergedIntoId: claim.mergedIntoId,
          rationale: blankToNull(parsed.data.rationale),
        },
      });
      return claim.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "claim-not-on-case") return { ok: false, step: "not-found", reason: "Case not found." };
    if (error instanceof Error && error.message === "rationale-required") return guard("A disputed or unknown claim needs a rationale naming what is missing.");
    if (error instanceof Error && error.message === "needs-excerpt") {
      return guard("A claim without a verbatim excerpt cannot leave needs-evidence status.");
    }
    if (error instanceof Error && error.message === "merge-target") return guard("Merging requires another claim on this case.");
    throw error;
  }
}

export async function linkClaimEvidence(input: ActorInput & { claimId: string } & z.infer<typeof linkInputSchema>): Promise<MutationOutcome<{ id: string }>> {
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) return guard("A link needs a source, a predicate, and a verbatim excerpt.");
  const auth = await authorizeWrite(input);
  if (!auth.ok) return auth;

  try {
    const id = await prisma.$transaction(async (tx) => {
      const claim = await tx.claim.findFirst({ where: { id: input.claimId, caseId: input.caseId, deletedAt: null }, select: { id: true } });
      if (!claim) throw new Error("claim-not-on-case");
      const source = await tx.source.findFirst({ where: { id: parsed.data.sourceId, caseId: input.caseId, deletedAt: null }, select: { id: true } });
      if (!source) throw new Error("source-not-on-case");
      const link = await tx.claimEvidenceLink.create({
        data: {
          claimId: claim.id,
          sourceId: source.id,
          predicate: parsed.data.predicate,
          excerpt: parsed.data.excerpt.trim(),
          rationale: blankToNull(parsed.data.rationale),
          createdById: input.actorId,
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "CLAIM_EVIDENCE_LINKED",
        actorId: input.actorId,
        payload: {
          linkId: link.id,
          claimId: claim.id,
          sourceId: source.id,
          predicate: link.predicate,
          rationale: link.rationale,
        },
      });
      return link.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && (error.message === "claim-not-on-case" || error.message === "source-not-on-case")) {
      return guard("The claim and source must both belong to this case.");
    }
    throw error;
  }
}

export async function recordClaimRelationship(input: ActorInput & z.infer<typeof relationshipInputSchema>): Promise<MutationOutcome<{ id: string }>> {
  const parsed = relationshipInputSchema.safeParse(input);
  if (!parsed.success) return guard("A relationship needs two different claims on this case and a predicate.");
  const auth = await authorizeWrite(input);
  if (!auth.ok) return auth;

  try {
    const id = await prisma.$transaction(async (tx) => {
      const claims = await tx.claim.findMany({
        where: { id: { in: [parsed.data.fromClaimId, parsed.data.toClaimId] }, caseId: input.caseId, deletedAt: null },
        select: { id: true },
      });
      if (claims.length !== 2) throw new Error("claims-not-on-case");
      if (parsed.data.evidenceId) {
        const source = await tx.source.findFirst({ where: { id: parsed.data.evidenceId, caseId: input.caseId, deletedAt: null }, select: { id: true } });
        if (!source) throw new Error("source-not-on-case");
      }
      const row = await tx.claimRelationship.create({
        data: {
          caseId: input.caseId,
          fromClaimId: parsed.data.fromClaimId,
          toClaimId: parsed.data.toClaimId,
          predicate: parsed.data.predicate,
          evidenceId: parsed.data.evidenceId ?? null,
          rationale: blankToNull(parsed.data.rationale),
          createdById: input.actorId,
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "CLAIM_RELATIONSHIP_RECORDED",
        actorId: input.actorId,
        payload: {
          relationshipId: row.id,
          fromClaimId: row.fromClaimId,
          toClaimId: row.toClaimId,
          predicate: row.predicate,
          evidenceId: row.evidenceId,
          rationale: row.rationale,
        },
      });
      return row.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && (error.message === "claims-not-on-case" || error.message === "source-not-on-case")) {
      return guard("The claims and any cited source must belong to this case.");
    }
    throw error;
  }
}

const PHASE1_REVIEW_ACTIONS = new Set(["NOTED", "EDITED"]);

export async function recordReview(input: ActorInput & z.infer<typeof reviewInputSchema>): Promise<MutationOutcome<{ id: string }>> {
  const parsed = reviewInputSchema.safeParse(input);
  if (!parsed.success) return guard("A review note needs an action.");
  if (!PHASE1_REVIEW_ACTIONS.has(parsed.data.action)) {
    return guard("Approver sign-off and contestation are not part of this version.");
  }
  const rationale = blankToNull(parsed.data.rationale);
  if (parsed.data.action === "EDITED" && !rationale) return guard("An edit note needs a rationale.");
  const auth = await authorizeWrite(input);
  if (!auth.ok) return auth;

  try {
    const id = await prisma.$transaction(async (tx) => {
      let snapshot: Prisma.InputJsonValue | undefined;
      if (parsed.data.claimId) {
        const claim = await tx.claim.findFirst({ where: { id: parsed.data.claimId, caseId: input.caseId, deletedAt: null } });
        if (!claim) throw new Error("claim-not-on-case");
        snapshot = {
          claimId: claim.id,
          claimType: claim.claimType,
          text: claim.text,
          confidence: claim.confidence,
          status: claim.status,
        };
      }
      const review = await tx.reviewTrail.create({
        data: {
          caseId: input.caseId,
          claimId: parsed.data.claimId ?? null,
          reviewerId: input.actorId,
          action: parsed.data.action as "NOTED" | "EDITED",
          rationale,
          snapshot,
          createdById: input.actorId,
        },
      });
      await appendEvent(tx, {
        caseId: input.caseId,
        type: "REVIEW_RECORDED",
        actorId: input.actorId,
        payload: {
          reviewId: review.id,
          claimId: review.claimId,
          action: review.action,
          rationale: review.rationale,
        },
      });
      return review.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof Error && error.message === "claim-not-on-case") return guard("That claim is not on this case.");
    throw error;
  }
}

export interface ClaimAuthorOption {
  id: string;
  displayName: string;
}

export interface ClaimGraph {
  access: CaseReadAccess;
  canAuthor: boolean;
  viewerCanSeeRestricted: boolean;
  view: ClaimsView;
  authors: ClaimAuthorOption[];
  sources: Array<{ id: string; title: string; kind: string }>;
  claimOptions: Array<{ id: string; text: string }>;
  evidenceOptions: Array<{ id: string; title: string }>;
}

function iso(value: Date): string {
  return value.toISOString();
}

export async function readClaimGraph(
  caseId: string,
  viewer: { userId: string; globalRole: GlobalRole },
): Promise<ClaimGraph | null> {
  const caseRow = await prisma.case.findUnique({ where: { id: caseId } });
  if (!caseRow) return null;
  const access = caseReadAccess(caseRow, viewer);
  if (!claimReadPermission(access) || !access) return null;
  const viewerCanSeeRestricted = access === "assigned-manager";

  const [sources, claims, links, relationships, evidenceItems] = await Promise.all([
    prisma.source.findMany({
      where: { caseId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: { evidenceItem: { select: { title: true } } },
    }),
    prisma.claim.findMany({ where: { caseId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    prisma.claimEvidenceLink.findMany({
      where: { deletedAt: null, claim: { caseId, deletedAt: null } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.claimRelationship.findMany({ where: { caseId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    prisma.evidenceItem.findMany({
      where: { caseId, scanStatus: { not: "REJECTED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true },
    }),
  ]);

  const claimRecords: ClaimRecord[] = claims.map((claim) => ({
    id: claim.id,
    claimType: claim.claimType,
    text: claim.text,
    confidence: claim.confidence,
    confidenceRationale: claim.confidenceRationale,
    status: claim.status,
    locale: claim.locale,
    createdAt: iso(claim.createdAt),
    createdById: claim.createdById,
    doNotSummarizeAsSettled: claim.doNotSummarizeAsSettled,
  }));
  const linkRecords: LinkRecord[] = links.map((link) => ({
    id: link.id,
    claimId: link.claimId,
    sourceId: link.sourceId,
    predicate: link.predicate,
    excerpt: link.excerpt,
    rationale: link.rationale,
    createdAt: iso(link.createdAt),
    createdById: link.createdById,
    deletedAt: link.deletedAt ? iso(link.deletedAt) : null,
  }));
  const sourceRecords: SourceRecord[] = sources.map((source) => ({
    id: source.id,
    title: source.title,
    kind: source.kind,
    citation: source.citation,
    legalFramework: source.legalFramework,
    evidenceItemId: source.evidenceItemId,
    evidenceTitle: source.evidenceItem?.title ?? null,
    visibility: source.visibility,
    language: source.language,
    origin: source.origin,
  }));
  const relationshipRecords: RelationshipRecord[] = relationships.map((row) => ({
    id: row.id,
    fromClaimId: row.fromClaimId,
    toClaimId: row.toClaimId,
    predicate: row.predicate,
    rationale: row.rationale,
    evidenceId: row.evidenceId,
  }));

  const authorIds = new Set<string>();
  for (const claim of claimRecords) authorIds.add(claim.createdById);
  for (const link of linkRecords) authorIds.add(link.createdById);
  const authors = authorIds.size
    ? await prisma.user.findMany({ where: { id: { in: [...authorIds] } }, select: { id: true, displayName: true } })
    : [];

  return {
    access,
    canAuthor: claimWritePermission({ access, globalRole: viewer.globalRole }).ok,
    viewerCanSeeRestricted,
    view: buildClaimsView({
      claims: claimRecords,
      links: linkRecords,
      sources: sourceRecords,
      relationships: relationshipRecords,
      viewerCanSeeRestricted,
    }),
    authors,
    sources: sources.map((source) => ({ id: source.id, title: source.title, kind: source.kind })),
    claimOptions: claims.map((claim) => ({ id: claim.id, text: claim.text })),
    evidenceOptions: evidenceItems,
  };
}
