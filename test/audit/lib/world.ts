import { randomUUID } from "node:crypto";
import { cfg, syntheticEmail } from "./config";
import { assertAuditDatabase, one, q } from "./db";
import { sha256Hex, signPayload } from "./crypto";
import { Client } from "./http";
import { SoftAuthenticator, claimInvite, register, signIn, tokenFromClaimPath } from "./webauthn";
import { evidenceForm, png, text } from "./files";
import { stub } from "./stub";

export type Role = "COMPLAINANT" | "RESPONDENT" | "CASE_MANAGER" | "ADMIN";
export interface Account { role: Role; email: string; name: string; userId: string; client: Client; auth: SoftAuthenticator }

export class UnexpectedResponse extends Error {}
/** Fail loudly (with the body) when a setup step does not do what the flow requires. */
export function ok(res: { status: number; text: string }, label: string, status = 200) {
  if (res.status !== status) throw new UnexpectedResponse(`${label}: expected HTTP ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
}

export async function makeAccount(role: "COMPLAINANT" | "RESPONDENT", tag = role.toLowerCase(), locale = "fr-CA"): Promise<Account> {
  const email = syntheticEmail(tag);
  const client = new Client(`${tag}`);
  const { options, verify, auth } = await register(client, { email, displayName: `Audit ${tag} ${cfg.run}`, globalRole: role, locale });
  if (options.status !== 200 || !verify || verify.status !== 200) throw new UnexpectedResponse(`register ${tag}: ${options.status}/${verify?.status} ${verify?.text ?? options.text}`);
  return { role, email, name: `Audit ${tag} ${cfg.run}`, userId: verify.json.id, client, auth };
}

/** No shipped tool creates an ADMIN. The account row and its invitation are inserted directly (synthetic, disposable DB); the claim ceremony is the real HTTP path. */
export async function makeAdmin(tag = "admin", locale = "fr-CA"): Promise<Account> {
  await assertAuditDatabase();
  const email = syntheticEmail(tag), userId = randomUUID(), name = `Audit ${tag} ${cfg.run}`;
  await q(`insert into "User"(id,email,"displayName",locale,"globalRole") values ($1,$2,$3,$4,'ADMIN')`, [userId, email, name, locale]);
  const token = signPayload({ purpose: "invite", userId, nonce: randomUUID() }, 72 * 3600);
  await q(`insert into "Invitation"(id,"userId","tokenHash",locale,"expiresAt") values ($1,$2,$3,$4,now() + interval '72 hours')`, [randomUUID(), userId, sha256Hex(token), locale]);
  const client = new Client(tag);
  const { options, verify, auth } = await claimInvite(client, token);
  if (options.status !== 200 || !verify || verify.status !== 200) throw new UnexpectedResponse(`admin claim: ${options.status}/${verify?.status} ${verify?.text ?? options.text}`);
  return { role: "ADMIN", email, name, userId, client, auth };
}

export async function makeManager(admin: Account, tag = "manager", locale = "fr-CA"): Promise<Account> {
  const email = syntheticEmail(tag), name = `Audit ${tag} ${cfg.run}`;
  const issued = await admin.client.post("/api/auth/invite", { email, displayName: name, globalRole: "CASE_MANAGER", locale });
  ok(issued, "issue manager invite");
  const client = new Client(tag);
  const { options, verify, auth } = await claimInvite(client, tokenFromClaimPath(issued.json.claimPath));
  if (options.status !== 200 || !verify || verify.status !== 200) throw new UnexpectedResponse(`manager claim: ${options.status}/${verify?.status} ${verify?.text ?? options.text}`);
  return { role: "CASE_MANAGER", email, name, userId: verify.json.id, client, auth };
}

/** A fresh session through the real sign-in ceremony. */
export async function freshSession(account: Account, label = `${account.role}-signin`): Promise<Client> {
  const client = new Client(label);
  const { verify } = await signIn(client, account.auth, account.email);
  if (!verify || verify.status !== 200) throw new UnexpectedResponse(`sign-in ${label}: ${verify?.status} ${verify?.text}`);
  return client;
}

export const statementId = async (locale = "fr-CA") => (await one<{ id: string }>(`select id from "ConsentStatementVersion" where locale=$1 order by "effectiveFrom" desc limit 1`, [locale]))!.id;

export async function createCase(complainant: Account, respondent: Account | string, opts: { category?: string; simulated?: boolean; displayName?: string } = {}) {
  const respondentEmail = typeof respondent === "string" ? respondent : respondent.email;
  const res = await complainant.client.post("/api/cases", {
    respondentEmail, respondentDisplayName: opts.displayName ?? "Audit placeholder respondent",
    requestedStatementVersionId: await statementId(), category: opts.category, simulated: opts.simulated,
  });
  return { res, caseId: res.json?.caseId as string };
}

export const upload = (account: Account, caseId: string, file: Buffer, opts: Parameters<typeof evidenceForm>[1] = {}) =>
  account.client.request("POST", `/api/cases/${caseId}/evidence`, { form: evidenceForm(file, opts) });

export interface Cast { comp: Account; resp: Account; cm: Account; admin: Account }
export type Stage = "DRAFT" | "OPEN" | "EVIDENCE_INTAKE" | "POSITIONS" | "DRAFTING" | "ISSUED" | "RESOLVED_CONSENT" | "CLOSED";
const ORDER: Stage[] = ["DRAFT", "OPEN", "EVIDENCE_INTAKE", "POSITIONS", "DRAFTING", "ISSUED", "RESOLVED_CONSENT", "CLOSED"];
const atLeast = (target: Stage, step: Stage) => ORDER.indexOf(target) >= ORDER.indexOf(step);

export async function makeCast(tag = "cast"): Promise<Cast> {
  const admin = await makeAdmin(`${tag}-admin`);
  const [comp, resp, cm] = await Promise.all([makeAccount("COMPLAINANT", `${tag}-comp`), makeAccount("RESPONDENT", `${tag}-resp`), makeManager(admin, `${tag}-cm`)]);
  return { comp, resp, cm, admin };
}

/** Drives a case through the real HTTP API up to `target`, asserting every step. */
export async function driveCase(cast: Cast, target: Stage, opts: { category?: string; simulated?: boolean; positionText?: [string, string] } = {}) {
  const { comp, resp, cm } = cast;
  await stub.control("anthropic", "ok");
  const { res, caseId } = await createCase(comp, resp, opts);
  ok(res, "create case");
  const info: { caseId: string; recommendationId?: string; evidenceIds: string[] } = { caseId, evidenceIds: [] };
  if (atLeast(target, "OPEN")) ok(await comp.client.post(`/api/cases/${caseId}/submit`), "submit");
  if (atLeast(target, "EVIDENCE_INTAKE")) ok(await cm.client.post(`/api/cases/${caseId}/open-intake`, { hasConflict: false }), "open intake");
  if (atLeast(target, "POSITIONS")) {
    ok(await upload(comp, caseId, png(), { title: "Complainant exhibit" }), "complainant evidence");
    ok(await upload(resp, caseId, text(), { title: "Respondent exhibit", kind: "MESSAGE" }), "respondent evidence");
    ok(await comp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-02", title: "Invoice received", description: "The complainant reports receiving the invoice.", locale: "en-CA" }), "complainant chronology", 201);
    ok(await resp.client.post(`/api/cases/${caseId}/chronology`, { occurredOn: "2026-01-01", title: "Invoice sent", description: "The respondent reports sending the invoice.", locale: "en-CA" }), "respondent chronology", 201);
    info.evidenceIds = (await q<{ id: string }>(`select id from "EvidenceItem" where "caseId"=$1 order by "createdAt"`, [caseId])).map((r) => r.id);
    ok(await cm.client.post(`/api/cases/${caseId}/close-intake`, {}), "close intake");
    ok(await comp.client.post(`/api/cases/${caseId}/positions`, { body: opts.positionText?.[0] ?? "The complainant says the goods never arrived and asks for a refund.", locale: "en-CA" }), "complainant position");
    ok(await resp.client.post(`/api/cases/${caseId}/positions`, { body: opts.positionText?.[1] ?? "The respondent says the goods were delivered on the stated date.", locale: "en-CA" }), "respondent position");
  }
  if (atLeast(target, "DRAFTING")) ok(await cm.client.post(`/api/cases/${caseId}/draft-requests`), "draft request");
  if (atLeast(target, "ISSUED")) {
    const draft = await cm.client.get(`/api/cases/${caseId}/draft`); ok(draft, "read draft");
    info.recommendationId = draft.json.id;
    ok(await cm.client.post(`/api/recommendations/${draft.json.id}/issue`, { checklist: { reviewedEvidence: true, confirmedLimits: true, acceptsResponsibility: true } }), "issue");
  }
  if (atLeast(target, "RESOLVED_CONSENT")) {
    const sid = await statementId();
    for (const who of [comp, resp]) ok(await who.client.post(`/api/cases/${caseId}/consent`, { action: "give", statementVersionId: sid }), `consent ${who.role}`);
  }
  if (atLeast(target, "CLOSED")) ok(await cm.client.post(`/api/cases/${caseId}/close`), "close case");
  return info;
}
