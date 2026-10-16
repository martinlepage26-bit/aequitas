"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { GlobalRole } from "../generated/prisma";
import { EvenLine, Icon, Mark, Wordmark } from "./icons";
import ThemeControls from "./ThemeControls";
import styles from "./workbench-shell.module.css";

export default function WorkbenchShell({
  locale,
  role,
  children,
}: {
  locale: string;
  role: GlobalRole | null;
  children: ReactNode;
}) {
  const tAuth = useTranslations("auth");
  const tRole = useTranslations("workspace.role");
  const tLanding = useTranslations("landing");
  const tCases = useTranslations("caseList");
  const tChrome = useTranslations("chrome");
  const pathname = usePathname();
  const signedIn = role !== null;
  const isAdmin = role === "ADMIN";
  const isComplainant = role === "COMPLAINANT";
  const roleClass = role === "COMPLAINANT" ? styles.roleComplainant
    : role === "RESPONDENT" ? styles.roleRespondent
      : role === "CASE_MANAGER" ? styles.roleManager
        : role === "ADMIN" ? styles.roleAdmin : "";
  const roleLabel = role === "COMPLAINANT" ? tRole("complainant")
    : role === "RESPONDENT" ? tRole("respondent")
      : role === "CASE_MANAGER" ? tRole("caseManager")
        : role === "ADMIN" ? tRole("admin") : null;
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
    <div className={`${styles.shell} ${roleClass}`}>
      <a className={styles.skip} href="#main-content">{tLanding("skipToContent")}</a>
      <div className={styles.frame}>
        <div id="workbench-rail" className={open ? `${styles.rail} ${styles.railOpen}` : styles.rail}>
          <nav className={styles.nav} aria-label={tAuth("account")}>
            <Link className={`${styles.navLink} ${styles.brand}`} href={home} aria-current={pathname === home ? "page" : undefined}>
              <Mark />
              <span className={styles.navLabel}><Wordmark>{tLanding("title")}</Wordmark></span>
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
            {!signedIn && (
              <div className={styles.navFooter}>
                <Link className={styles.navLink} href={`/${locale}/auth/sign-in`} aria-current={pathname.startsWith(`/${locale}/auth/sign-in`) ? "page" : undefined}>
                  <Icon name="login" />
                  <span className={styles.navLabel}>{tAuth("signIn")}</span>
                </Link>
              </div>
            )}
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
              <div className={styles.masthead}>
                <p className={styles.wordmark}><Wordmark>{tLanding("title")}</Wordmark></p>
                <EvenLine />
                {roleLabel && <span className={styles.roleBadge}>{roleLabel}</span>}
              </div>
            </div>
            <div className={styles.toolbarTools}>
              <ThemeControls locale={locale} />
              {signedIn && (
                <form className={styles.signOut} action="/api/auth/sign-out" method="post">
                  <input type="hidden" name="locale" value={locale} />
                  <button type="submit">{tAuth("signOut")}</button>
                </form>
              )}
            </div>
          </header>
          <div id="main-content" className={styles.content} tabIndex={-1}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
