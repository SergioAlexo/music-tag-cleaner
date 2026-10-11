import type { IndexProgress, IndexSummary } from "../types";

/** "3 new, 1 changed, 0 removed" — the sidebar Refresh result, in the words the owner asked for. */
export function describeRefresh(s: Pick<IndexSummary, "added" | "updated" | "removed" | "errors">): string {
  const base = `${s.added} new, ${s.updated} changed, ${s.removed} removed`;
  const failed = s.errors.length;
  return failed ? `${base} (${failed} unreadable)` : base;
}

/** Whether a refresh found anything at all (used to keep the focus-triggered one quiet). */
export function refreshChangedAnything(s: Pick<IndexSummary, "added" | "updated" | "removed">): boolean {
  return s.added + s.updated + s.removed > 0;
}

/** One-line progress for the Refresh button while the scan runs. */
export function describeProgress(p: IndexProgress | null): string {
  if (!p || p.phase === "walking") return "Scanning folders…";
  if (p.phase === "done") return "Finishing…";
  if (p.total <= 0) return "Reading…";
  return `Reading ${p.done.toLocaleString()} of ${p.total.toLocaleString()}…`;
}
