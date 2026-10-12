import { describe, expect, it } from "vitest";
import { validateManifest, THEME_TOKENS } from "./manifest";
import { applyVars, BUILTIN_THEMES, forcedMode, resolveTheme, themeVars } from "./themes";

function fakeEl() {
  const props: Record<string, string> = {};
  return {
    style: {
      setProperty: (k: string, v: string) => void (props[k] = v),
      removeProperty: (k: string) => void delete props[k],
    },
    props,
  };
}

describe("themes", () => {
  it("every bundled theme is a valid manifest", () => {
    for (const t of BUILTIN_THEMES) {
      const r = validateManifest(t);
      expect(r.ok, `${t.id}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it("a complete variant sets every token as a CSS variable", () => {
    const t = resolveTheme("midnight", [])!;
    const vars = themeVars(t.contributes.theme!, true);
    for (const k of THEME_TOKENS.filter((k) => k !== "violet")) expect(vars[`--${k}`]).toBeTruthy();
    expect(vars["--background"]).toBe("#0a0e1a");
  });

  it("invalid colour values are skipped, not injected", () => {
    const vars = themeVars({ dark: { background: "red; } body { display:none", primary: "#123456" } }, true);
    expect(vars["--background"]).toBeUndefined();
    expect(vars["--primary"]).toBe("#123456");
  });

  it("radius and font become --app-radius / --app-font", () => {
    const vars = themeVars({ radius: "0.75rem", font: "Georgia, serif", light: {} }, false);
    expect(vars["--app-radius"]).toBe("0.75rem");
    expect(vars["--app-font"]).toBe("Georgia, serif");
  });

  it("forced mode: dark-only themes force dark, auto themes and no theme follow the OS", () => {
    expect(forcedMode(resolveTheme("midnight", []))).toBe("dark");
    expect(forcedMode(resolveTheme("warm-vinyl", []))).toBeNull();
    expect(forcedMode(resolveTheme("", []))).toBeNull();
    expect(resolveTheme("nope", [])).toBeNull();
  });

  it("applyVars sets new values and removes stale ones when the theme changes", () => {
    const el = fakeEl();
    const a = applyVars(el, { "--background": "#000", "--app-radius": "1rem" }, []);
    expect(el.props["--app-radius"]).toBe("1rem");
    applyVars(el, { "--background": "#111" }, a);
    expect(el.props).toEqual({ "--background": "#111" });
    applyVars(el, {}, ["--background"]);
    expect(el.props).toEqual({});
  });
});
