// Identity tokens for Aequitas. The #a39e5c olive seed and three 90-degree
// hue rotations define the tetrad. Light and dark UI colours keep those hues
// while changing lightness for readable text and controls.
// Hex values here are the source of truth;
// src/app/theme-tokens.css is generated from themeTokenCss().

export const tetradicSeedColors = {
  olive: "#a39e5c",
  teal: "#5ca37b",
  indigo: "#5c61a3",
  berry: "#a35c84",
} as const;

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
  noteBorder: string;
  accent: string;
  accentText: string;
  onAccent: string;
}

export const surfaces: Record<ThemeMode, ModeTokens> = {
  light: {
    bg: "#f3f4eb",
    panel: "#fffef7",
    raised: "#f9faf1",
    text: "#1d211b",
    muted: "#4d574d",
    border: "#c9cfbf",
    controlBorder: "#65705e",
    danger: "#8f2b3a",
    focus: "#5d5b2e",
    noteText: "#4a4b22",
    noteBg: "#efedcf",
    noteBorder: tetradicSeedColors.olive,
    accent: "#5d5b2e",
    accentText: "#5d5b2e",
    onAccent: "#fffef7",
  },
  dark: {
    bg: "#101712",
    panel: "#172119",
    raised: "#202c22",
    text: "#f1f5eb",
    muted: "#c2d0be",
    border: "#425345",
    controlBorder: "#9eae9b",
    danger: "#ffb4bd",
    focus: "#c8c37c",
    noteText: "#e5e3b3",
    noteBg: "#30351f",
    noteBorder: tetradicSeedColors.olive,
    accent: "#c8c37c",
    accentText: "#c8c37c",
    onAccent: "#142017",
  },
};

// Stable source colours. These identify who supplied a record even when a
// different role is viewing it; they are separate from the viewer's accent.
export const roleColors: Record<ThemeMode, Record<"complainant" | "respondent" | "manager" | "admin", string>> = {
  light: { complainant: "#713353", respondent: "#343e80", manager: "#286e4c", admin: "#5d5b2e" },
  dark: { complainant: "#e8a8ca", respondent: "#b5b9ed", manager: "#a9dfb9", admin: "#c8c37c" },
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
    "--note-border": s.noteBorder,
    "--brand-seed": tetradicSeedColors.olive,
    "--accent": s.accent,
    "--accent-text": s.accentText,
    "--on-accent": s.onAccent,
    "--role-complainant": roleColors[mode].complainant,
    "--role-respondent": roleColors[mode].respondent,
    "--role-manager": roleColors[mode].manager,
    "--role-admin": roleColors[mode].admin,
    "--radius": "14px",
    "--radius-sm": "9px",
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
