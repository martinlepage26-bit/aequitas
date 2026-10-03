import { getTranslations } from "next-intl/server";
import AuthForm from "../../../../components/AuthForm";
import { authReturnPath } from "../../../../lib/authPaths";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: `${t("signIn")} · Aequitas` };
}

export default async function SignInPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string }> }) {
  const { locale } = await params;
  const { next } = await searchParams;
  return <AuthForm returnTo={authReturnPath(locale, next)} />;
}
