import "../src/lib/loadEnv";
import { issueStoredInvite } from "../src/lib/invitations";
// Demo seed for the private, loopback-only demo service (aequitas-demo).
//
// Creates, idempotently, a handful of SIMULATED cases at different states
// (fr-CA and en-CA) and pre-provisioned demo accounts, then writes one
// single-use invitation link per not-yet-claimed account to a private file.
// See docs/demo.md for the full procedure.
//
// Safety rails (it refuses to run otherwise):
//  - AEQUITAS_DEMO_SEED_CONFIRM must equal "seed-aequitas-demo";
//  - DATABASE_URL must name the database "aequitas_demo" exactly, so it can
//    never target the dev database ("aequitas") or a test database.
//
// Usage (on the server, with the demo env loaded, never .env.local's DB):
//   set -a; . ~/.secrets/aequitas-demo.env; set +a
//   AEQUITAS_DEMO_SEED_CONFIRM=seed-aequitas-demo npm run seed:demo
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "../src/lib/prisma";
import { invitePath } from "../src/lib/invite";
import { closeIntake, createCase, openIntake, submitCase, submitEvidence, submitPosition } from "../src/domain/mutate";
import type { DisputeCategory, GlobalRole } from "../src/generated/prisma";

const CONFIRM = "seed-aequitas-demo";
const DEMO_DB = "aequitas_demo";

function refuseUnlessSafe() {
  if (process.env.AEQUITAS_DEMO_SEED_CONFIRM !== CONFIRM) {
    throw new Error(`Refusing to seed: set AEQUITAS_DEMO_SEED_CONFIRM=${CONFIRM} to confirm.`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Refusing to seed: DATABASE_URL is not set.");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName !== DEMO_DB) {
    throw new Error(`Refusing to seed database "${dbName}": the demo seed only targets "${DEMO_DB}" (never dev or test).`);
  }
}

const STATEMENTS = [
  {
    version: 1,
    locale: "fr-CA",
    body: "[TEXTE PROVISOIRE — non révisé par un avocat] En consentant, je confirme avoir pris connaissance de la recommandation proposée et j'accepte le résultat proposé pour ce dossier. Mon consentement est explicite et je peux le retirer en tout temps avant la fermeture du dossier.",
  },
  {
    version: 1,
    locale: "en-CA",
    body: "[PLACEHOLDER TEXT — not reviewed by counsel] By consenting, I confirm I have reviewed the proposed recommendation and I accept the proposed outcome for this case. My consent is explicit and I may withdraw it at any time before the case is closed.",
  },
];

interface DemoAccount {
  key: string;
  email: string;
  displayName: string;
  globalRole: GlobalRole;
  locale: "fr-CA" | "en-CA";
}

// Fictional people and businesses only (".example" is a reserved domain).
const ACCOUNTS: DemoAccount[] = [
  { key: "complainant", email: "plaignante@aequitas-demo.example", displayName: "Camille Demers (démo)", globalRole: "COMPLAINANT", locale: "fr-CA" },
  { key: "complainantEn", email: "complainant@aequitas-demo.example", displayName: "Jordan Hale (demo)", globalRole: "COMPLAINANT", locale: "en-CA" },
  { key: "respondent", email: "intimee@aequitas-demo.example", displayName: "Atelier Fictif inc. (démo)", globalRole: "RESPONDENT", locale: "fr-CA" },
  { key: "manager", email: "gestion@aequitas-demo.example", displayName: "Alex Morin, gestionnaire (démo)", globalRole: "CASE_MANAGER", locale: "fr-CA" },
];

type Stage = "DRAFT" | "OPEN" | "EVIDENCE_INTAKE" | "POSITIONS_ONE" | "POSITIONS_BOTH";

interface DemoCase {
  reference: string;
  category: DisputeCategory;
  complainant: "complainant" | "complainantEn";
  stage: Stage;
  locale: "fr-CA" | "en-CA";
  evidence?: { by: "complainant" | "respondent"; title: string; lines: string[] }[];
  positions?: { by: "complainant" | "respondent"; body: string }[];
}

const CASES: DemoCase[] = [
  { reference: "AE-DEMO-001", category: "RETAIL", complainant: "complainant", stage: "DRAFT", locale: "fr-CA" },
  { reference: "AE-DEMO-002", category: "TENANCY", complainant: "complainant", stage: "OPEN", locale: "fr-CA" },
  {
    reference: "AE-DEMO-003",
    category: "FREELANCE",
    complainant: "complainantEn",
    stage: "EVIDENCE_INTAKE",
    locale: "en-CA",
    evidence: [
      {
        by: "complainant",
        title: "Signed statement of work (simulated)",
        lines: ["SIMULATED DOCUMENT - demo data only", "Statement of work: website redesign, 4 pages.", "Delivery date: March 14. Fee: 2,400 CAD, half on signature, half on delivery.", "Signed by both parties on February 3."],
      },
    ],
  },
  {
    reference: "AE-DEMO-004",
    category: "RETAIL",
    complainant: "complainant",
    stage: "POSITIONS_BOTH",
    locale: "fr-CA",
    evidence: [
      {
        by: "complainant",
        title: "Facture d'achat du lave-vaisselle (simulée)",
        lines: ["DOCUMENT SIMULE - donnees de demonstration", "Facture 10482 - Atelier Fictif inc.", "Lave-vaisselle modele LV-300, 849,00 $ taxes incluses.", "Date d'achat : 12 janvier. Garantie du fabricant : 12 mois."],
      },
      {
        by: "respondent",
        title: "Rapport du technicien (simulé)",
        lines: ["DOCUMENT SIMULE - donnees de demonstration", "Visite du 3 avril. Pompe de vidange bloquee par un corps etranger.", "Aucun defaut de fabrication constate. Nettoyage effectue, appareil fonctionnel au depart."],
      },
    ],
    positions: [
      {
        by: "complainant",
        body: "J'ai acheté un lave-vaisselle en janvier. Il a cessé de vidanger en mars, deux mois plus tard. Le technicien est venu en avril, mais le problème est revenu une semaine après. Je demande le remplacement de l'appareil ou le remboursement de l'achat.",
      },
      {
        by: "respondent",
        body: "Notre technicien a constaté un objet coincé dans la pompe, pas un défaut de fabrication. L'appareil fonctionnait à son départ. Nous offrons une deuxième visite sans frais et, si un défaut est confirmé, une réparation sous garantie.",
      },
    ],
  },
  {
    reference: "AE-DEMO-005",
    category: "EMPLOYMENT",
    complainant: "complainantEn",
    stage: "POSITIONS_ONE",
    locale: "en-CA",
    positions: [
      {
        by: "complainant",
        body: "My last two pay periods did not include the overtime I worked during the inventory weeks. I kept my own log of the extra hours and asked my supervisor twice. I am asking for the unpaid overtime to be paid.",
      },
    ],
  },
];

async function pdfFor(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 22, size: 12, font }));
  return Buffer.from(await doc.save());
}

function must<T extends { ok: boolean }>(outcome: T, what: string): T {
  if (!outcome.ok) throw new Error(`Demo seed step failed (${what}): ${JSON.stringify(outcome)}`);
  return outcome;
}

async function main() {
  refuseUnlessSafe();

  for (const s of STATEMENTS) {
    await prisma.consentStatementVersion.upsert({
      where: { version_locale: { version: s.version, locale: s.locale } },
      update: {},
      create: { ...s, effectiveFrom: new Date() },
    });
  }

  const users: Record<string, { id: string; globalRole: GlobalRole; locale: string }> = {};
  for (const a of ACCOUNTS) {
    const existing = await prisma.user.findUnique({ where: { email: a.email } });
    if (existing && existing.globalRole !== a.globalRole) throw new Error(`Demo account ${a.email} exists with an unexpected role.`);
    const user = existing ?? (await prisma.user.create({ data: { email: a.email, displayName: a.displayName, globalRole: a.globalRole, locale: a.locale } }));
    users[a.key] = user;
  }

  let created = 0;
  for (const c of CASES) {
    if (await prisma.case.findUnique({ where: { referenceNumber: c.reference } })) continue;
    const complainant = users[c.complainant];
    const respondent = users.respondent;
    const manager = users.manager;
    const statement = await prisma.consentStatementVersion.findFirstOrThrow({ where: { locale: complainant.locale }, orderBy: { effectiveFrom: "desc" } });

    const made = must(
      await createCase({
        actorId: complainant.id,
        actorRole: "COMPLAINANT",
        referenceNumber: c.reference,
        complainantId: complainant.id,
        respondentId: respondent.id,
        category: c.category,
        disputeDescription:
          c.positions?.[0]?.body ??
          (c.locale.startsWith("fr")
            ? "Démonstration : un différend simulé au sujet d'une obligation non respectée."
            : "Demonstration: a simulated dispute about an obligation that was not met."),
        simulated: true,
        requestedStatementVersionId: statement.id,
        currentStatementVersionId: statement.id,
      }),
      `${c.reference} create`
    );
    if (!made.ok) continue;
    const caseId = made.data.caseId;
    created++;
    if (c.stage === "DRAFT") continue;

    must(await submitCase({ actorId: complainant.id, actorRole: "COMPLAINANT", caseId }), `${c.reference} submit`);
    if (c.stage === "OPEN") continue;

    must(await openIntake({ actorId: manager.id, actorRole: "CASE_MANAGER", caseId, hasConflict: false }), `${c.reference} open intake`);
    for (const e of c.evidence ?? []) {
      const party = e.by === "complainant" ? complainant : respondent;
      must(
        await submitEvidence({
          actorId: party.id,
          actorRole: party.globalRole,
          caseId,
          kind: "DOCUMENT",
          title: e.title,
          buffer: await pdfFor(e.lines),
          mimeType: "application/pdf",
        }),
        `${c.reference} evidence`
      );
    }
    if (c.stage === "EVIDENCE_INTAKE") continue;

    const hasBoth = (c.evidence ?? []).some((e) => e.by === "complainant") && (c.evidence ?? []).some((e) => e.by === "respondent");
    must(
      await closeIntake({
        actorId: manager.id,
        actorRole: "CASE_MANAGER",
        caseId,
        overrideReason: hasBoth ? undefined : "Dossier de démonstration : dépôt de pièces non requis. / Demo case: no evidence required.",
      }),
      `${c.reference} close intake`
    );
    for (const p of c.positions ?? []) {
      const party = p.by === "complainant" ? complainant : respondent;
      must(await submitPosition({ actorId: party.id, actorRole: party.globalRole, caseId, body: p.body, locale: c.locale }), `${c.reference} position`);
    }
  }

  // One single-use claim link per demo account that has no passkey yet.
  const baseUrl = process.env.DEMO_BASE_URL ?? "http://localhost:3417";
  const lines: string[] = [`# Aequitas demo invitation links, generated ${new Date().toISOString()}. Single use, 72 h. Keep private.`];
  for (const a of ACCOUNTS) {
    const count = await prisma.webAuthnCredential.count({ where: { userId: users[a.key].id } });
    if (count > 0) {
      lines.push(`${a.globalRole}\t${a.email}\t(already claimed: sign in at ${baseUrl}/auth/sign-in)`);
      continue;
    }
    const { token } = await issueStoredInvite(users[a.key].id, users[a.key].locale);
    lines.push(`${a.globalRole}\t${a.email}\t${baseUrl}${invitePath(a.locale, token)}`);
  }
  const outFile = process.env.DEMO_INVITES_FILE ?? path.join(homedir(), ".secrets", "aequitas-demo-invites.txt");
  mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  writeFileSync(outFile, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(outFile, 0o600);

  const total = await prisma.case.count({ where: { referenceNumber: { startsWith: "AE-DEMO-" } } });
  console.log(`Demo seed OK: ${created} case(s) created this run, ${total} demo case(s) in total, ${ACCOUNTS.length} demo account(s).`);
  console.log(`Invitation links written to ${outFile} (mode 600). They are not printed here.`);
}

main()
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
