import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PluginManager } from "./manager";
import type { PluginManifest } from "./manifest";
import { applyVars, forcedMode, resolveTheme, themeVars } from "./themes";

/** Theme plugins found in the plugins folder (code-free, so always available). */
export function useInstalledThemes(manager: PluginManager): PluginManifest[] {
  const v = useSyncExternalStore(manager.subscribe, manager.getVersion);
  return useMemo(
    () => manager.entries.flatMap((e) => (e.manifest?.kind === "theme" ? [e.manifest] : [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v, manager],
  );
}

/**
 * Applies the chosen theme's tokens to <html> (D2). Returns the light/dark the
 * theme forces, or null when the app should keep following the OS, so the
 * caller can feed it into the existing `dark` class effect. With no theme
 * chosen this does nothing at all, which is the default.
 */
export function useAppTheme(themeId: string, installed: PluginManifest[]): "light" | "dark" | null {
  const theme = resolveTheme(themeId, installed);
  const forced = forcedMode(theme);
  const [osDark, setOsDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const applied = useRef<string[]>([]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const dark = forced ? forced === "dark" : osDark;
  useEffect(() => {
    const spec = theme?.contributes.theme;
    applied.current = applyVars(document.documentElement, spec ? themeVars(spec, dark) : {}, applied.current);
  }, [theme, dark]);

  return forced;
}
