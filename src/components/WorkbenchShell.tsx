"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon, Mark } from "./icons";
import ThemeControls from "./ThemeControls";
import styles from "./workbench-shell.module.css";

export default function WorkbenchShell({
  locale,
  signedIn,
  isAdmin,
  isComplainant,
  children,
}: {
  locale: string;
  signedIn: boolean;
  isAdmin: boolean;
  isComplainant: boolean;
  children: ReactNode;
}) {
  const tAuth = useTranslations("auth");
  const tLanding = useTranslations("landing");
  const tCases = useTranslations("caseList");
  const tChrome = useTranslations("chrome");
  const pathname = usePathname();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const open = openPath === pathname;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPath(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const home = `/${locale}`;
  const cases = `/${locale}/cases`;
  const newer = `/${locale}/cases/new`;
  const onNew = pathname === newer;
  const onCases = pathname === cases || (pathname.startsWith(`${cases}/`) && !onNew);

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main-content">{tLanding("skipToContent")}</a>
      <div className={styles.frame}>
        <div id="workbench-rail" className={open ? `${styles.rail} ${styles.railOpen}` : styles.rail}>
          <nav className={styles.nav} aria-label={tAuth("account")}>
            <Link className={`${styles.navLink} ${styles.brand}`} href={home} aria-current={pathname === home ? "page" : undefined}>
              <Mark />
              <span className={styles.navLabel}>{tLanding("title")}</span>
            </Link>
            <Link className={styles.navLink} href={cases} aria-current={onCases ? "page" : undefined}>
              <Icon name="cases" />
              <span className={styles.navLabel}>{tAuth("cases")}</span>
            </Link>
            {isComplainant && (
              <Link className={styles.navLink} href={newer} aria-current={onNew ? "page" : undefined}>
                <Icon name="plus" />
                <span className={styles.navLabel}>{tCases("startNew")}</span>
              </Link>
            )}
            {isAdmin && (
              <Link className={styles.navLink} href={`/${locale}/admin/invites`} aria-current={pathname.startsWith(`/${locale}/admin`) ? "page" : undefined}>
                <Icon name="mail" />
                <span className={styles.navLabel}>{tAuth("invites")}</span>
              </Link>
            )}
            <div className={styles.navFooter}>
              {signedIn ? (
                <form action="/api/auth/sign-out" method="post">
                  <input type="hidden" name="locale" value={locale} />
                  <button className={styles.navButton} type="submit">
                    <Icon name="logout" />
                    <span className={styles.navLabel}>{tAuth("signOut")}</span>
                  </button>
                </form>
              ) : (
                <Link className={styles.navLink} href={`/${locale}/auth/sign-in`} aria-current={pathname.startsWith(`/${locale}/auth/sign-in`) ? "page" : undefined}>
                  <Icon name="login" />
                  <span className={styles.navLabel}>{tAuth("signIn")}</span>
                </Link>
              )}
            </div>
          </nav>
        </div>
        {open && <button type="button" className={styles.backdrop} aria-label={tChrome("closeNavigation")} onClick={() => setOpenPath(null)} />}
        <div className={styles.stage}>
          <header className={styles.toolbar}>
            <div className={styles.toolbarLead}>
              <button
                type="button"
                className={styles.menuButton}
                aria-expanded={open}
                aria-controls="workbench-rail"
                aria-label={open ? tChrome("closeNavigation") : tChrome("openNavigation")}
                onClick={() => setOpenPath(open ? null : pathname)}
              >
                <Icon name={open ? "close" : "menu"} />
              </button>
              <p className={styles.wordmark}>{tLanding("title")}</p>
            </div>
            <ThemeControls locale={locale} />
          </header>
          <div id="main-content" className={styles.content} tabIndex={-1}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
