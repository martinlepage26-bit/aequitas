import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "../../../../lib/session";
import { prisma } from "../../../../lib/prisma";
import { DISPUTE_CATEGORIES, resolveRoleTerm } from "../../../../i18n/categoryGlossary";
import IntakeForm from "./IntakeForm";

export default async function NewCasePage() {
  const session = await getSession();
  if (!session) redirect("/auth/sign-in");
  if (session.globalRole !== "COMPLAINANT") notFound();

  const complainant = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
  const currentStatement = await prisma.consentStatementVersion.findFirst({
    where: { locale: complainant.locale },
    orderBy: { effectiveFrom: "desc" },
  });

  const t = await getTranslations("newCase");

  // Handoff 2026-08-15-070312: the complainant picks the dispute's domain at
  // intake — the option labels are generated from the same category glossary
  // the workspace page and AI prompts read from (src/i18n/categoryGlossary.ts),
  // so there's exactly one place these term pairs are defined.
  const categoryOptions = DISPUTE_CATEGORIES.map((category) => ({
    value: category,
    label: `${capitalize(resolveRoleTerm(category, "complainant", complainant.locale))} / ${capitalize(
      resolveRoleTerm(category, "respondent", complainant.locale)
    )}`,
  }));

  return (
    <main style={{ maxWidth: "40rem", margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>{t("title")}</h1>
      {!currentStatement ? (
        <p role="alert">{t("noStatement", { locale: complainant.locale })}</p>
      ) : (
        <IntakeForm statementVersionId={currentStatement.id} statementBody={currentStatement.body} categoryOptions={categoryOptions} />
      )}
    </main>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
