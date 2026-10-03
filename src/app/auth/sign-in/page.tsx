import { redirect } from "next/navigation";
import { authLocale, signInPath } from "../../../lib/authPaths";

export default async function LegacySignIn({ searchParams }: { searchParams: Promise<{ locale?: string; next?: string }> }) {
  const { locale, next } = await searchParams;
  redirect(signInPath(authLocale(locale), next));
}
