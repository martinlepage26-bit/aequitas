import "../src/lib/loadEnv";
import { prisma } from "../src/lib/prisma";

/**
 * Functional seed data — not M6's demo/simulated-case seed (Appendix A).
 * `create_case`'s statementVersionsCurrent guard has nothing to compare
 * against without at least one ConsentStatementVersion per locale, so
 * without this, no case can ever be created in a fresh database.
 *
 * PLACEHOLDER TEXT. Appendix B human task #1: "Quebec lawyer review of
 * consent statement wording (FR + EN) before production." Do not treat
 * this wording as legally reviewed.
 */
const STATEMENTS: Array<{ version: number; locale: string; body: string }> = [
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

async function main() {
  for (const statement of STATEMENTS) {
    await prisma.consentStatementVersion.upsert({
      where: { version_locale: { version: statement.version, locale: statement.locale } },
      update: {},
      create: { ...statement, effectiveFrom: new Date() },
    });
  }
  console.log(`Seeded ${STATEMENTS.length} consent statement version(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
