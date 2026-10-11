/**
 * Themes (D2): plugins with `kind: "theme"` that map the app's existing colour
 * tokens (`--background`, `--card`, `--primary`, ... in styles.css) for light
 * and dark, plus optional radius and font. They are applied as inline custom
 * properties on <html>, which beat both `:root` and `.dark`, so nothing in the
 * stylesheet changes and removing a theme restores the stock look exactly.
 *
 * Follow-the-OS (no theme) stays the default; settings v7 removed the manual
 * light/dark toggle on purpose and a theme is opt-in. A theme only forces
 * light/dark when its manifest says `mode: "light" | "dark"` (a dark-only theme
 * is unreadable against the light base).
 *
 * No React imports: unit-tested.
 */
import { themeColor, THEME_TOKENS, type PluginManifest, type ThemeSpec } from "./manifest";

function theme(
  id: string,
  name: string,
  description: string,
  spec: ThemeSpec,
): PluginManifest {
  return {
    id,
    name,
    version: "1.0.0",
    author: "Music Tag Cleaner",
    description,
    apiVersion: 1,
    kind: "theme",
    permissions: [],
    contributes: { theme: spec },
  };
}

export const BUILTIN_THEMES: PluginManifest[] = [
  theme("midnight", "Midnight", "Deep navy with a soft blue accent. Always dark.", {
    mode: "dark",
    dark: {
      background: "#0a0e1a", foreground: "#e6ebf5", card: "#101626", "card-foreground": "#e6ebf5",
      popover: "#0d1322", "popover-foreground": "#e6ebf5", primary: "#6ea8ff", "primary-foreground": "#06142e",
      secondary: "#1a2238", "secondary-foreground": "#e6ebf5", muted: "#151c30", "muted-foreground": "#8f9bb8",
      accent: "#202a45", "accent-foreground": "#e6ebf5", border: "#1f2942", input: "#283354", ring: "#6ea8ff",
      destructive: "#f87171", "destructive-foreground": "#ffffff", violet: "#a78bfa",
    },
  }),
  theme("rekordbox-dark", "Rekordbox-ish", "Neutral dark gray with Rekordbox-style blue. Always dark.", {
    mode: "dark",
    dark: {
      background: "#161616", foreground: "#ececec", card: "#1f1f1f", "card-foreground": "#ececec",
      popover: "#1a1a1a", "popover-foreground": "#ececec", primary: "#2a8cff", "primary-foreground": "#ffffff",
      secondary: "#2a2a2a", "secondary-foreground": "#ececec", muted: "#232323", "muted-foreground": "#9a9a9a",
      accent: "#303030", "accent-foreground": "#ececec", border: "#2e2e2e", input: "#353535", ring: "#2a8cff",
      destructive: "#ef4444", "destructive-foreground": "#ffffff", violet: "#8b5cf6",
    },
  }),
  theme("serato-dark", "Serato-ish", "Near-black with a cyan accent. Always dark.", {
    mode: "dark",
    dark: {
      background: "#0b0b0c", foreground: "#f2f2f2", card: "#141416", "card-foreground": "#f2f2f2",
      popover: "#101012", "popover-foreground": "#f2f2f2", primary: "#19c3d6", "primary-foreground": "#031a1d",
      secondary: "#1c1c20", "secondary-foreground": "#f2f2f2", muted: "#17171a", "muted-foreground": "#9b9ba3",
      accent: "#25252a", "accent-foreground": "#f2f2f2", border: "#242428", input: "#2e2e33", ring: "#19c3d6",
      destructive: "#ff5a5f", "destructive-foreground": "#ffffff", violet: "#a78bfa",
    },
  }),
  theme("high-contrast", "High contrast", "Maximum contrast: black and white with strong borders. Follows the OS light/dark.", {
    mode: "auto",
    light: {
      background: "#ffffff", foreground: "#000000", card: "#ffffff", "card-foreground": "#000000",
      popover: "#ffffff", "popover-foreground": "#000000", primary: "#0033cc", "primary-foreground": "#ffffff",
      secondary: "#f0f0f0", "secondary-foreground": "#000000", muted: "#f0f0f0", "muted-foreground": "#1a1a1a",
      accent: "#e0e0e0", "accent-foreground": "#000000", border: "#000000", input: "#000000", ring: "#0033cc",
      destructive: "#b00020", "destructive-foreground": "#ffffff",
    },
    dark: {
      background: "#000000", foreground: "#ffffff", card: "#000000", "card-foreground": "#ffffff",
      popover: "#000000", "popover-foreground": "#ffffff", primary: "#ffd400", "primary-foreground": "#000000",
      secondary: "#1a1a1a", "secondary-foreground": "#ffffff", muted: "#1a1a1a", "muted-foreground": "#e0e0e0",
      accent: "#2e2e2e", "accent-foreground": "#ffffff", border: "#ffffff", input: "#ffffff", ring: "#ffd400",
      destructive: "#ff6b6b", "destructive-foreground": "#000000",
    },
  }),
  theme("warm-vinyl", "Warm vinyl", "Cream paper and amber, like a record sleeve. Follows the OS light/dark.", {
    mode: "auto",
    radius: "0.75rem",
    light: {
      background: "#faf3e6", foreground: "#2b1d14", card: "#f3e8d3", "card-foreground": "#2b1d14",
      popover: "#faf3e6", "popover-foreground": "#2b1d14", primary: "#b4531f", "primary-foreground": "#fff8ee",
      secondary: "#efe2c8", "secondary-foreground": "#2b1d14", muted: "#efe2c8", "muted-foreground": "#7a6552",
      accent: "#e8d8b8", "accent-foreground": "#2b1d14", border: "#dccdb0", input: "#dccdb0", ring: "#b4531f",
      destructive: "#b3261e", "destructive-foreground": "#ffffff",
    },
    dark: {
      background: "#17110c", foreground: "#f1e4cf", card: "#1f1711", "card-foreground": "#f1e4cf",
      popover: "#1b140e", "popover-foreground": "#f1e4cf", primary: "#e08a4b", "primary-foreground": "#2a1304",
      secondary: "#2b2017", "secondary-foreground": "#f1e4cf", muted: "#251b13", "muted-foreground": "#b09a80",
      accent: "#33261b", "accent-foreground": "#f1e4cf", border: "#33261b", input: "#3d2d20", ring: "#e08a4b",
      destructive: "#ef6b5f", "destructive-foreground": "#ffffff",
    },
  }),
];

/** Looks a theme up in the bundled list, then among installed theme plugins. */
export function resolveTheme(id: string, installed: PluginManifest[]): PluginManifest | null {
  if (!id) return null;
  const all = [...BUILTIN_THEMES, ...installed.filter((m) => m.kind === "theme")];
  return all.find((m) => m.id === id && m.contributes.theme) ?? null;
}

/** Whether the theme dictates light/dark; null = follow the OS. */
export function forcedMode(t: PluginManifest | null): "light" | "dark" | null {
  const m = t?.contributes.theme?.mode;
  return m === "light" || m === "dark" ? m : null;
}

/** The custom properties a theme sets for the given variant. Invalid values are skipped. */
export function themeVars(spec: ThemeSpec, dark: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const tokens = dark ? spec.dark : spec.light;
  for (const key of THEME_TOKENS) {
    const v = themeColor(tokens?.[key]);
    if (v) out[`--${key}`] = v;
  }
  if (spec.radius) out["--app-radius"] = spec.radius;
  if (spec.font) out["--app-font"] = spec.font;
  return out;
}

/** Preview colours for the picker. */
export function themeSwatch(m: PluginManifest, dark: boolean): string[] {
  const spec = m.contributes.theme;
  if (!spec) return [];
  if (spec.swatch?.length) return spec.swatch.map((c) => themeColor(c) ?? "#888");
  const t = (dark ? spec.dark ?? spec.light : spec.light ?? spec.dark) ?? {};
  return [t.background, t.card, t.primary, t.accent].map((c) => themeColor(c) ?? "#888");
}

interface StyleTarget {
  style: { setProperty(k: string, v: string): void; removeProperty(k: string): void };
}

/**
 * Sets `vars` on the element and removes whatever a previous call set that is
 * no longer wanted. Returns the keys now applied, to pass back next time.
 */
export function applyVars(el: StyleTarget, vars: Record<string, string>, previous: string[]): string[] {
  for (const k of previous) if (!(k in vars)) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return Object.keys(vars);
}
