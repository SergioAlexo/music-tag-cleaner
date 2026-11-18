/**
 * Which permission a plugin needs to run a registry action (D2).
 *
 * Deny by default: an action that is not in this table and is not read-only
 * needs an explicit `action:<id>` grant. `script.run` and `plugins.*` are never
 * reachable from plugin code (a script step could smuggle past the per-action
 * check; `plugins.*` would let a plugin widen itself).
 */
import type { ActionInfo } from "../lib/actions";

const NEVER = [/^script\.run$/, /^plugins\./];

const EXACT: Record<string, string> = {
  // tags
  "tags.edit": "tags.write",
  "tags.editRaw": "tags.write",
  "tags.setRating": "tags.write",
  "tags.generateIds": "tags.write",
  "tags.standardize": "tags.write",
  "tags.clearFields": "tags.write",
  "tags.aiClean": "tags.write",
  "tags.rekordboxToTags": "tags.write",
  "tags.migrateTrackIds": "tags.write",
  "tags.unifyIds": "tags.write",
  "language.detect": "tags.write",
  "lyrics.fetch": "tags.write",
  "changes.apply": "tags.write",
  "changes.cancel": "tags.write",
  "history.undo": "tags.write",
  "history.redo": "tags.write",
  // artwork
  "artwork.standardize": "artwork.write",
  "artwork.remove": "artwork.write",
  "artwork.find": "artwork.write",
  "artwork.junkArt": "artwork.write",
  // backups
  "backup.tags": "backup",
  "backup.archive": "backup",
  // files
  "files.rename": "files.move",
  "files.renameToStandard": "files.move",
  "files.standardizeContainers": "files.move",
  "organize.open": "files.move",
  "convert.run": "files.move",
  "convert.open": "files.move",
  "stems.open": "files.move",
  "files.delete": "files.delete",
  "duplicates.delete": "files.delete",
  "backup.restore": "files.delete",
  // synth presets (host-side engine; writes only into the chosen output folder)
  "presets.open": "presets",
  "presets.scan": "presets",
  "presets.convert": "presets",
  "presets.verify": "presets",
  "presets.apply": "presets",
  "presets.report": "presets",
  // view state
  "table.select": "ui.control",
  "table.setColumns": "ui.control",
  "nav.goto": "ui.control",
  "session.open": "ui.control",
  "library.addToSession": "ui.control",
  "library.loadFacet": "ui.control",
  "library.refresh": "ui.control",
};

/** Actions that need no permission at all (they only show a message). */
const FREE = new Set(["ui.notify"]);

export type Decision = { allowed: true } | { allowed: false; reason: string; needs?: string };

/** Registry id of the plugin's own actions: `plugin.<segment>.<local>`. */
export function isOwnAction(actionId: string, segment: string): boolean {
  return actionId.startsWith(`plugin.${segment}.`);
}

/**
 * Decides whether a plugin holding `granted` permissions may run `actionId`.
 * `info` is the registry's description (for the read-only flag); undefined
 * means the action doesn't exist, which the registry reports itself.
 */
export function checkActionPermission(
  granted: readonly string[],
  actionId: string,
  info: Pick<ActionInfo, "readOnly"> | undefined,
  segment: string,
): Decision {
  if (NEVER.some((r) => r.test(actionId))) {
    // A plugin may call its own `plugin.<seg>.*` actions even though they start with "plugin.".
    if (!isOwnAction(actionId, segment)) {
      return { allowed: false, reason: `plugins cannot call "${actionId}"` };
    }
  }
  if (isOwnAction(actionId, segment)) return { allowed: true };
  if (FREE.has(actionId)) return { allowed: true };
  if (granted.includes(`action:${actionId}`)) return { allowed: true };
  const needs = EXACT[actionId] ?? (info?.readOnly ? "read" : undefined);
  if (!needs) {
    return {
      allowed: false,
      reason: `"${actionId}" needs the explicit permission "action:${actionId}"`,
      needs: `action:${actionId}`,
    };
  }
  if (granted.includes(needs)) return { allowed: true };
  return { allowed: false, reason: `"${actionId}" needs the "${needs}" permission`, needs };
}

/** `network:*.example.com` / `network:api.example.com[:port]`. */
export function networkAllowed(granted: readonly string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.host.toLowerCase();
  const hostname = u.hostname.toLowerCase();
  for (const g of granted) {
    if (!g.startsWith("network:")) continue;
    const pat = g.slice(8).toLowerCase();
    if (pat.startsWith("*.")) {
      if (hostname.endsWith(pat.slice(1)) && hostname.length > pat.length - 1) return true;
    } else if (pat === host || pat === hostname) {
      return true;
    }
  }
  return false;
}
