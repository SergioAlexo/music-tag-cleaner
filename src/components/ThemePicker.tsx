import type { PluginManifest } from "../plugins/manifest";
import { BUILTIN_THEMES, themeSwatch } from "../plugins/themes";
import { cn } from "./ui";

/**
 * Theme chooser (D2). "Follow OS" (id "") is the default and the first tile;
 * every other tile is a bundled or installed theme. Shared by Settings and the
 * Plugins page so both stay in step.
 */
export function ThemePicker({
  themeId,
  installed,
  onPick,
}: {
  themeId: string;
  installed: PluginManifest[];
  onPick: (id: string) => void;
}) {
  const dark = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const all = [
    ...BUILTIN_THEMES,
    ...installed.filter((m) => m.kind === "theme" && !BUILTIN_THEMES.some((b) => b.id === m.id)),
  ];
  const tile = (id: string, name: string, desc: string, colors: string[]) => (
    <button
      key={id || "os"}
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={themeId === id}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors hover:bg-accent/40",
        themeId === id ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <div className="mb-2 flex h-5 overflow-hidden rounded border">
        {colors.length === 0 ? (
          <div className="flex-1 bg-gradient-to-r from-white to-neutral-900" />
        ) : (
          colors.map((c, i) => <div key={i} className="flex-1" style={{ background: c }} />)
        )}
      </div>
      <div className="text-sm font-medium">{name}</div>
      <div className="text-xs text-muted-foreground">{desc}</div>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {tile("", "Follow OS", "Light or dark with Windows (default).", [])}
      {all.map((m) => tile(m.id, m.name, m.description, themeSwatch(m, dark)))}
    </div>
  );
}
