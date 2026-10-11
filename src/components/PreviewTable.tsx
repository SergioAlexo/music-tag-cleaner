import { useMemo, useState } from "react";
import { FIELD_LABELS, type PendingChange, type PreviewMode } from "../types";
import { Button, cn } from "./ui";

interface Props {
  rows: PendingChange[];
  mode: PreviewMode;
  busy: boolean;
  onRowsChange: (rows: PendingChange[]) => void;
  onApply: () => void;
  onCancel: () => void;
}

export default function PreviewTable({ rows, mode, busy, onRowsChange, onApply, onCancel }: Props) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const readOnly = mode === "history";

  const visible = useMemo(
    () => (showUnchanged ? rows : rows.filter((r) => r.changed)),
    [rows, showUnchanged],
  );
  const changedCount = rows.filter((r) => r.changed).length;
  const includedCount = rows.filter((r) => r.changed && r.include).length;
  const fileCount = new Set(rows.filter((r) => r.changed && r.include).map((r) => r.path)).size;

  const setInclude = (id: string, include: boolean) => {
    onRowsChange(rows.map((r) => (r.id === id ? { ...r, include } : r)));
  };
  const setAll = (include: boolean) => {
    onRowsChange(rows.map((r) => (r.changed ? { ...r, include } : r)));
  };
  /** User-edited "after" value: recompute changed/include from the new value. */
  const editAfter = (id: string, after: string) => {
    onRowsChange(
      rows.map((r) => {
        if (r.id !== id) return r;
        const changed = after !== r.before;
        return { ...r, after, changed, include: changed && r.include ? true : changed };
      }),
    );
  };

  let lastPath = "";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">
            {mode === "ai"
                ? "Preview — AI Cleanup"
                : mode === "clear"
                  ? "Preview — Clear Fields"
                  : mode === "history"
                    ? "Session Changes"
                    : mode === "trackIdMigration"
                      ? "Preview — Move Track Number IDs to Track ID"
                      : mode === "rekordboxSync"
                        ? "Preview — Rekordbox BPM / Key / Rating into tags"
                        : "Preview — Standardize"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {readOnly
              ? `${changedCount} change${changedCount === 1 ? "" : "s"} across ${new Set(rows.map((r) => r.path)).size} file(s) this session — already applied`
              : `${changedCount} change${changedCount === 1 ? "" : "s"} across ${new Set(rows.filter((r) => r.changed).map((r) => r.path)).size} file(s) — nothing is written until you apply`}
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-[var(--primary)]"
            checked={showUnchanged}
            onChange={(e) => setShowUnchanged(e.target.checked)}
          />
          Show unchanged rows
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 font-medium">File</th>
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">Before</th>
              <th className="px-3 py-2 font-medium">After</th>
              {!readOnly && <th className="px-3 py-2 text-center font-medium">Include</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const firstOfFile = row.path !== lastPath;
              lastPath = row.path;
              return (
                <tr
                  key={row.id}
                  className={cn(
                    "border-t border-border/50",
                    firstOfFile && "border-t-border",
                    !row.changed && "opacity-50",
                  )}
                >
                  <td
                    className="max-w-[180px] truncate px-3 py-1.5 text-muted-foreground"
                    title={row.path}
                  >
                    {firstOfFile ? row.filename : ""}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {FIELD_LABELS[row.field] ?? row.field}
                  </td>
                  <td
                    className="max-w-[260px] truncate px-3 py-1.5 text-muted-foreground"
                    title={row.before}
                  >
                    {row.before || <span className="italic opacity-60">(empty)</span>}
                  </td>
                  <td className="max-w-[280px] px-3 py-1.5">
                    {row.kind === "remove" || readOnly ? (
                      <span className={cn(row.kind === "remove" && "italic text-destructive")}>
                        {row.after || <span className="italic opacity-60">(empty)</span>}
                      </span>
                    ) : (
                      <input
                        value={row.after}
                        onChange={(e) => editAfter(row.id, e.target.value)}
                        className={cn(
                          "w-full rounded border border-transparent bg-transparent px-1 py-0.5 outline-none hover:border-border focus:border-primary focus:bg-background",
                          row.changed ? "font-medium text-primary" : "text-muted-foreground",
                        )}
                      />
                    )}
                  </td>
                  {!readOnly && (
                    <td className="px-3 py-1.5 text-center">
                      {row.changed && (
                        <input
                          type="checkbox"
                          className="accent-[var(--primary)]"
                          checked={row.include}
                          onChange={(e) => setInclude(row.id, e.target.checked)}
                        />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={readOnly ? 4 : 5} className="px-3 py-8 text-center text-muted-foreground">
                  {readOnly ? "No changes made yet this session." : "No changes to show — these files are already clean."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t px-4 py-3">
        {readOnly ? (
          <div />
        ) : (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAll(true)}>
              ✓ Select All
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAll(false)}>
              ✗ Deselect All
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button size="sm" onClick={onApply} disabled={busy || includedCount === 0}>
              Apply Selected ({includedCount} change{includedCount === 1 ? "" : "s"}, {fileCount}{" "}
              file{fileCount === 1 ? "" : "s"})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
