// Identity tokens for Aequitas. One sealing-wax accent on case-file paper
// (light) and warm night (dark). Hex values here are the source of truth;
// src/app/theme-tokens.css is generated from themeTokenCss().

export const THEME_STORAGE_KEY = "aequitas-theme";

export type ThemeMode = "light" | "dark";

export interface ModeTokens {
  bg: string;
  panel: string;
  raised: string;
  text: string;
  muted: string;
  border: string;
  controlBorder: string;
  danger: string;
  focus: string;
  noteText: string;
  noteBg: string;
  accent: string;
  accentText: string;
  onAccent: string;
}

export const surfaces: Record<ThemeMode, ModeTokens> = {
  light: {
    bg: "#e7e1d6",
    panel: "#f7f3eb",
    raised: "#fbf8f3",
    text: "#1a1612",
    muted: "#514a42",
    border: "#c4b8a6",
    controlBorder: "#6a6156",
    danger: "#8a2a2a",
    focus: "#1a1612",
    noteText: "#4a3b13",
    noteBg: "#fff3cd",
    accent: "#7c1e1e",
    accentText: "#7c1e1e",
    onAccent: "#fff8f4",
  },
  dark: {
    bg: "#100e0c",
    panel: "#1a1714",
    raised: "#241f1b",
    text: "#f6f1e8",
    muted: "#d0c6b8",
    border: "#4a4036",
    controlBorder: "#a89886",
    danger: "#f0b4b4",
    focus: "#f6f1e8",
    noteText: "#4a3b13",
    noteBg: "#fff3cd",
    accent: "#e7b1a6",
    accentText: "#f0c8be",
    onAccent: "#1a120f",
  },
};

// Stable source colours. These identify who supplied a record even when a
// different role is viewing it; they are separate from the viewer's accent.
export const roleColors: Record<ThemeMode, Record<"complainant" | "respondent" | "manager" | "admin", string>> = {
  light: { complainant: "#7c1e1e", respondent: "#214c6b", manager: "#29583d", admin: "#76542c" },
  dark: { complainant: "#e7b1a6", respondent: "#9bcce9", manager: "#a4d4ae", admin: "#e5c38e" },
};

function decls(mode: ThemeMode): Record<string, string> {
  const s = surfaces[mode];
  return {
    "color-scheme": mode,
    "--bg": s.bg,
    "--panel": s.panel,
    "--panel-raised": s.raised,
    "--text": s.text,
    "--muted": s.muted,
    "--border": s.border,
    "--control-border": s.controlBorder,
    "--danger": s.danger,
    "--focus": s.focus,
    "--note-text": s.noteText,
    "--note-bg": s.noteBg,
    "--accent": s.accent,
    "--accent-text": s.accentText,
    "--on-accent": s.onAccent,
    "--role-complainant": roleColors[mode].complainant,
    "--role-respondent": roleColors[mode].respondent,
    "--role-manager": roleColors[mode].manager,
    "--role-admin": roleColors[mode].admin,
    "--radius": "0",
    "--radius-sm": "0",
  };
}

function block(selector: string, values: Record<string, string>): string {
  const body = Object.entries(values).map(([key, value]) => `  ${key}: ${value};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

export function themeTokenCss(): string {
  return [
    "/* Generated from src/ui/workbenchTheme.ts — do not edit by hand. */",
    block(":root,\n:root[data-theme=\"light\"]", decls("light")),
    block(":root[data-theme=\"dark\"]", decls("dark")),
  ].join("\n\n") + "\n";
}

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark";
}

export const THEME_BOOT_SCRIPT = `(function(){var themeKey=${JSON.stringify(THEME_STORAGE_KEY)};function systemTheme(){return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}function apply(){var stored=null;try{stored=localStorage.getItem(themeKey);}catch(e){}var theme=stored==="light"||stored==="dark"?stored:systemTheme();document.documentElement.setAttribute("data-theme",theme);}apply();window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",apply);})();`;

function channel(hex: string, index: number): number {
  const value = parseInt(hex.slice(1), 16);
  const byte = (value >> ((2 - index) * 8)) & 255;
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground: string, background: string): number {
  const lum = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const lighter = Math.max(lum(foreground), lum(background));
  const darker = Math.min(lum(foreground), lum(background));
  return (lighter + 0.05) / (darker + 0.05);
}
