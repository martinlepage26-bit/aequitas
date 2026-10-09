import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { THEME_BOOT_SCRIPT } from "../ui/workbenchTheme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
});

export async function generateMetadata() {
  const locale = (await headers()).get("x-aequitas-locale");
  return locale === "en-CA" ? {
    title: "Aequitas — resolution workspace",
    description: "A human-reviewable dispute-resolution workspace: proposals, consent, and legal research are tracked and attributed.",
  } : {
    title: "Aequitas — espace de résolution",
    description: "Un espace de résolution des différends : propositions, consentements et recherche juridique sont révisés et attribués.",
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers();
  const locale = headerList.get("x-aequitas-locale") === "en-CA" ? "en-CA" : "fr-CA";
  const nonce = headerList.get("x-nonce") ?? undefined;
  return (
    <html lang={locale} className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable}`} suppressHydrationWarning>
      <body>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
