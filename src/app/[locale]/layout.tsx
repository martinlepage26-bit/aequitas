import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { routing } from "../../i18n/routing";
import { getSession } from "../../lib/session";
import { prisma } from "../../lib/prisma";
import WorkbenchShell from "../../components/WorkbenchShell";

/**
 * Nested layout, deliberately without <html>/<body> — those stay owned by
 * the true root layout (src/app/layout.tsx) so the M0-era demo page
 * (src/app/page.js, outside [locale]) keeps working unmodified. See
 * DECISIONS.md's M2 note on why /[locale] and the old root aren't merged.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  setRequestLocale(locale);
  const messages = await getMessages();
  const session = await getSession();
  const account = session
    ? await prisma.user.findUnique({ where: { id: session.userId }, select: { displayName: true } })
    : null;

  return (
    <NextIntlClientProvider messages={messages}>
      <WorkbenchShell locale={locale} role={session?.globalRole ?? null} displayName={account?.displayName ?? null}>
        {children}
      </WorkbenchShell>
    </NextIntlClientProvider>
  );
}
