"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { THEME_STORAGE_KEY, isThemeMode, type ThemeMode } from "../ui/workbenchTheme";
import styles from "./workbench-shell.module.css";

function storedTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
  } catch { /* private mode */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ThemeControls({ locale }: { locale: string }) {
  const t = useTranslations("chrome");
  const router = useRouter();
  const pathname = usePathname();
  const [theme, setTheme] = useState<ThemeMode>("light");

  useEffect(() => {
    const sync = () => setTheme(storedTheme());
    sync();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  function chooseTheme(next: ThemeMode) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* private mode */ }
  }

  function chooseLocale(nextLocale: string) {
    if (nextLocale === locale) return;
    const path = pathname.replace(`/${locale}`, `/${nextLocale}`);
    const params = new URLSearchParams(window.location.search);
    const next = params.get("next");
    if (next?.startsWith(`/${locale}/`)) params.set("next", `/${nextLocale}/${next.slice(locale.length + 2)}`);
    const query = params.toString();
    router.push(query ? `${path}?${query}` : path);
  }

  return (
    <div className={styles.filters}>
      <label className={styles.toolbarField} htmlFor="appearance">
        <span>{t("appearance")}</span>
        <select id="appearance" value={theme} onChange={(event) => chooseTheme(event.target.value as ThemeMode)}>
          <option value="light">{t("light")}</option>
          <option value="dark">{t("dark")}</option>
        </select>
      </label>
      <label className={styles.toolbarField} htmlFor="language">
        <span>{t("language")}</span>
        <select id="language" value={locale} onChange={(event) => chooseLocale(event.target.value)}>
          <option value="en-CA">{t("english")}</option>
          <option value="fr-CA">{t("french")}</option>
        </select>
      </label>
    </div>
  );
}
