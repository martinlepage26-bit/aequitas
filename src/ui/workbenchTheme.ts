// Runtime visual system for the workbench shell.
// Light and dark surfaces plus four accent palettes. Hex values here are the
// source of truth; src/app/theme-tokens.css is generated from themeTokenCss().

export const THEME_STORAGE_KEY = "aequitas-theme";
export const PALETTE_STORAGE_KEY = "aequitas-palette";
export const PALETTE_IDS = ["slate", "harbour", "ember", "iris"] as const;

export type PaletteId = (typeof PALETTE_IDS)[number];
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
}

export interface AccentTokens {
  accent: string;
  accentText: string;
  onAccent: string;
}

export interface Palette {
  id: PaletteId;
  swatches: readonly [string, string, string, string, string, string, string, string];
  light: AccentTokens;
  dark: AccentTokens;
}

export const surfaces: Record<ThemeMode, ModeTokens> = {
  light: {
    bg: "#e7edf2",
    panel: "#f6f8fa",
    raised: "#ffffff",
    text: "#1a2330",
    muted: "#3d4c5c",
    border: "#c3cdd6",
    controlBorder: "#5c6b7a",
    danger: "#8a2a2a",
    focus: "#1a2330",
    noteText: "#4a3b13",
    noteBg: "#fff3cd",
  },
  dark: {
    bg: "#12161c",
    panel: "#1c232d",
    raised: "#243140",
    text: "#f3f5f8",
    muted: "#c9d2dc",
    border: "#3c4856",
    controlBorder: "#93a3b5",
    danger: "#f3b4b4",
    focus: "#f0c14a",
    noteText: "#4a3b13",
    noteBg: "#fff3cd",
  },
};

export const palettes: readonly Palette[] = [
  {
    id: "slate",
    swatches: ["#1b3a4b", "#2f4a6b", "#4c6e91", "#7fa1c4", "#c4a46a", "#8a5a2b", "#1e6b3c", "#8a2a2a"],
    light: { accent: "#2f4a6b", accentText: "#2f4a6b", onAccent: "#ffffff" },
    dark: { accent: "#9ebfda", accentText: "#d5e4f2", onAccent: "#0e1a28" },
  },
  {
    id: "harbour",
    swatches: ["#0e3d3d", "#0f5c5c", "#1a7a72", "#3d9b8f", "#e0a106", "#c46b2c", "#1d4e89", "#5c4a72"],
    light: { accent: "#0f5c5c", accentText: "#0c4a4a", onAccent: "#ffffff" },
    dark: { accent: "#8ed4c8", accentText: "#b7e4de", onAccent: "#062624" },
  },
  {
    id: "ember",
    swatches: ["#4a1d12", "#9a3412", "#c2410c", "#d97706", "#e8b86d", "#3f6212", "#1e3a5f", "#6d28d9"],
    light: { accent: "#9a3412", accentText: "#8a2e10", onAccent: "#ffffff" },
    dark: { accent: "#f0b08a", accentText: "#f8c9b0", onAccent: "#2a1008" },
  },
  {
    id: "iris",
    swatches: ["#1e1b4b", "#3730a3", "#4f46e5", "#7c3aed", "#0f766e", "#b45309", "#be123c", "#64748b"],
    light: { accent: "#3730a3", accentText: "#312e81", onAccent: "#ffffff" },
    dark: { accent: "#c4b5fd", accentText: "#d9d6fe", onAccent: "#1e1b4b" },
  },
];

const slate = palettes[0];

function surfaceDecls(mode: ThemeMode, palette: Palette): Record<string, string> {
  const s = surfaces[mode];
  const a = palette[mode];
  const decls: Record<string, string> = {
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
    "--accent": a.accent,
    "--accent-text": a.accentText,
    "--on-accent": a.onAccent,
    "--radius": "12px",
    "--radius-sm": "8px",
  };
  palette.swatches.forEach((hex, index) => {
    decls[`--swatch-${index + 1}`] = hex;
  });
  return decls;
}

function accentDecls(mode: ThemeMode, palette: Palette): Record<string, string> {
  const a = palette[mode];
  const decls: Record<string, string> = {
    "--accent": a.accent,
    "--accent-text": a.accentText,
    "--on-accent": a.onAccent,
  };
  palette.swatches.forEach((hex, index) => {
    decls[`--swatch-${index + 1}`] = hex;
  });
  return decls;
}

function block(selector: string, decls: Record<string, string>): string {
  const body = Object.entries(decls).map(([key, value]) => `  ${key}: ${value};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

export function themeTokenCss(): string {
  const parts = [
    "/* Generated from src/ui/workbenchTheme.ts — do not edit by hand. */",
    block(":root,\n:root[data-theme=\"light\"]", surfaceDecls("light", slate)),
    block(":root[data-theme=\"dark\"]", surfaceDecls("dark", slate)),
  ];
  for (const palette of palettes) {
    if (palette.id === "slate") continue;
    parts.push(block(`:root[data-palette="${palette.id}"]:not([data-theme="dark"])`, accentDecls("light", palette)));
    parts.push(block(`:root[data-theme="dark"][data-palette="${palette.id}"]`, accentDecls("dark", palette)));
  }
  return `${parts.join("\n\n")}\n`;
}

export function isPaletteId(value: string | null): value is PaletteId {
  return !!value && (PALETTE_IDS as readonly string[]).includes(value);
}

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark";
}

export const THEME_BOOT_SCRIPT = `(function(){var themeKey=${JSON.stringify(THEME_STORAGE_KEY)};var paletteKey=${JSON.stringify(PALETTE_STORAGE_KEY)};var palettes=${JSON.stringify(PALETTE_IDS)};function systemTheme(){return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}function apply(){var stored=null;var palette=null;try{stored=localStorage.getItem(themeKey);palette=localStorage.getItem(paletteKey);}catch(e){}var theme=stored==="light"||stored==="dark"?stored:systemTheme();document.documentElement.setAttribute("data-theme",theme);if(palettes.indexOf(palette)!==-1)document.documentElement.setAttribute("data-palette",palette);}apply();window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",apply);})();`;

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
