"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PALETTE_IDS, THEME_STORAGE_KEY, PALETTE_STORAGE_KEY, isPaletteId, isThemeMode, palettes, type PaletteId, type ThemeMode } from "../ui/workbenchTheme";
import styles from "./workbench-shell.module.css";

function storedTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
  } catch { /* private mode */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedPalette(): PaletteId {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (isPaletteId(stored)) return stored;
  } catch { /* private mode */ }
  return PALETTE_IDS[0];
}

export default function ThemeControls({ locale }: { locale: string }) {
  const t = useTranslations("chrome");
  const router = useRouter();
  const pathname = usePathname();
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [palette, setPalette] = useState<PaletteId>(PALETTE_IDS[0]);

  useEffect(() => {
    const sync = () => {
      setTheme(storedTheme());
      setPalette(storedPalette());
    };
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

  function choosePalette(next: PaletteId) {
    setPalette(next);
    document.documentElement.setAttribute("data-palette", next);
    try { localStorage.setItem(PALETTE_STORAGE_KEY, next); } catch { /* private mode */ }
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
      <fieldset className={styles.paletteField}>
        <legend>{t("palette")}</legend>
        <div className={styles.paletteList}>
          {palettes.map((item) => (
            <label key={item.id} className={styles.paletteOption}>
              <input type="radio" name="palette" value={item.id} checked={palette === item.id} onChange={() => choosePalette(item.id)} />
              <span>{t(`themes.${item.id}`)}</span>
              <span className={styles.swatches} aria-hidden="true">
                {item.swatches.map((hex) => <span key={hex} className={styles.swatch} style={{ background: hex }} />)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
