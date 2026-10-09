import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  PALETTE_IDS,
  THEME_BOOT_SCRIPT,
  contrastRatio,
  palettes,
  surfaces,
  themeTokenCss,
  type ThemeMode,
} from "../../src/ui/workbenchTheme";

describe("workbench theme", () => {
  it("offers four palettes of eight swatches", () => {
    expect(palettes.map((palette) => palette.id)).toEqual([...PALETTE_IDS]);
    expect(palettes).toHaveLength(4);
    for (const palette of palettes) {
      expect(palette.swatches).toHaveLength(8);
      expect(new Set(palette.swatches).size).toBe(8);
    }
    expect(palettes).toMatchSnapshot();
  });

  it("keeps text, controls, and accents at WCAG AA contrast in both modes", () => {
    for (const mode of ["light", "dark"] as ThemeMode[]) {
      const surface = surfaces[mode];
      for (const background of [surface.bg, surface.panel, surface.raised]) {
        expect(contrastRatio(surface.text, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.muted, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.danger, background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(surface.noteText, surface.noteBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(surface.controlBorder, surface.panel)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(surface.focus, surface.panel)).toBeGreaterThanOrEqual(3);
      for (const palette of palettes) {
        const accent = palette[mode];
        expect(contrastRatio(accent.onAccent, accent.accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(accent.accentText, surface.panel)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(accent.accentText, surface.raised)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(surfaces.light.noteText).toBe("#4a3b13");
    expect(surfaces.dark.noteText).toBe(surfaces.light.noteText);
  });

  it("writes the same tokens the stylesheet serves", () => {
    const css = readFileSync(new URL("../../src/app/theme-tokens.css", import.meta.url), "utf8");
    expect(css).toBe(themeTokenCss());
    expect(css).toContain('[data-theme="dark"]');
    for (const id of PALETTE_IDS) {
      if (id === "slate") continue;
      expect(css).toContain(`[data-palette="${id}"]`);
    }
  });

  it("applies a stored theme and follows the system scheme until one is chosen", () => {
    const storage: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    let dark = true;
    const listeners: Array<() => void> = [];
    const context = vm.createContext({
      localStorage: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => { storage[key] = value; },
      },
      document: { documentElement: { setAttribute: (key: string, value: string) => { attrs[key] = value; } } },
      window: {
        matchMedia: () => ({
          get matches() { return dark; },
          addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
        }),
      },
    });
    vm.runInContext(THEME_BOOT_SCRIPT, context);
    expect(attrs["data-theme"]).toBe("dark");
    expect(attrs["data-palette"]).toBeUndefined();

    dark = false;
    listeners[0]?.();
    expect(attrs["data-theme"]).toBe("light");

    storage["aequitas-theme"] = "dark";
    storage["aequitas-palette"] = "harbour";
    listeners[0]?.();
    expect(attrs["data-theme"]).toBe("dark");
    expect(attrs["data-palette"]).toBe("harbour");

    dark = true;
    storage["aequitas-theme"] = "light";
    storage["aequitas-palette"] = "nope";
    listeners[0]?.();
    expect(attrs["data-theme"]).toBe("light");
    expect(attrs["data-palette"]).toBe("harbour");
  });
});
