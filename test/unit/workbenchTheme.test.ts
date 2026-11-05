import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  THEME_BOOT_SCRIPT,
  contrastRatio,
  roleColors,
  surfaces,
  tetradicSeedColors,
  themeTokenCss,
  type ThemeMode,
} from "../../src/ui/workbenchTheme";

describe("workbench theme", () => {
  it("builds both themes from the olive tetrad", () => {
    expect(tetradicSeedColors).toEqual({ olive: "#a39e5c", teal: "#5ca37b", indigo: "#5c61a3", berry: "#a35c84" });
    expect(surfaces.light.accent).toBe("#5d5b2e");
    expect(surfaces.dark.accent).toBe("#c8c37c");
    expect(surfaces.light.accentText).toBe(surfaces.light.accent);
    expect(themeTokenCss()).not.toContain("data-palette");
    expect(surfaces).toMatchSnapshot();
  });

  it("keeps text, controls, and the signature colour at WCAG AA contrast in both modes", () => {
    for (const mode of ["light", "dark"] as ThemeMode[]) {
      const surface = surfaces[mode];
      for (const background of [surface.bg, surface.panel, surface.raised]) {
        expect(contrastRatio(surface.text, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.muted, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.danger, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.accentText, background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(surface.noteText, surface.noteBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(surface.onAccent, surface.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(surface.controlBorder, surface.panel)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(surface.controlBorder, surface.raised)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(surface.focus, surface.panel)).toBeGreaterThanOrEqual(3);
    }
    expect(surfaces.light.noteBorder).toBe(tetradicSeedColors.olive);
    expect(surfaces.dark.noteBorder).toBe(tetradicSeedColors.olive);
  });

  it("writes the same tokens the stylesheet serves", () => {
    const css = readFileSync(new URL("../../src/app/theme-tokens.css", import.meta.url), "utf8");
    expect(css).toBe(themeTokenCss());
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("--radius: 14px;");
    expect(css).not.toContain("data-palette");
    expect(css).not.toContain("--swatch-");
  });

  it("keeps each source role distinct and legible in light and dark modes", () => {
    for (const mode of ["light", "dark"] as ThemeMode[]) {
      const colors = Object.values(roleColors[mode]);
      expect(new Set(colors).size).toBe(4);
      for (const color of colors) {
        expect(contrastRatio(color, surfaces[mode].panel)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(color, surfaces[mode].raised)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surfaces[mode].onAccent, color)).toBeGreaterThanOrEqual(4.5);
      }
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
    dark = false;
    listeners[0]?.();
    expect(attrs["data-theme"]).toBe("dark");

    storage["aequitas-theme"] = "nope";
    dark = true;
    listeners[0]?.();
    expect(attrs["data-theme"]).toBe("dark");

    storage["aequitas-theme"] = "light";
    listeners[0]?.();
    expect(attrs["data-theme"]).toBe("light");
  });
});
