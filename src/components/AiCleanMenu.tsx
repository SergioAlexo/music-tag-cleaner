import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Sparkles } from "lucide-react";
import { AI_CLEAN_FIELDS, AI_CLEAN_FIELD_HINTS, FIELD_LABELS, type AiCleanField } from "../types";
import { Button } from "./ui";

interface Props {
  /** The saved default set (`settings.aiCleanFields`) the main button runs. */
  fields: AiCleanField[];
  /** " (manual)" / " (Claude)" / "" — which backend the button drives. */
  backendSuffix: string;
  fillEmptyOnly: boolean;
  disabled?: boolean;
  /** Runs AI Clean; without an argument it uses the saved default set. */
  onRun: (fields?: AiCleanField[]) => void;
  /** Stores `fields` as the new default set. */
  onSaveDefault: (fields: AiCleanField[]) => void;
}

const label = (f: AiCleanField) => FIELD_LABELS[f] ?? f;

/**
 * Split button for AI Clean. The left half runs the field set chosen in
 * Settings; the caret opens a list where one click cleans a single field
 * ("Only Year"), or a ticked subset runs once without touching the default.
 * Same portal/positioning approach as `ClearFieldsMenu` (the toolbar scrolls,
 * so an absolutely positioned popover would be clipped).
 */
export function AiCleanMenu({ fields, backendSuffix, fillEmptyOnly, disabled, onRun, onSaveDefault }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AiCleanField[]>(fields);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Re-seed the checklist from the saved default each time the menu opens.
  useEffect(() => {
    if (open) setDraft(fields);
  }, [open, fields]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    };
    reposition();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  const toggle = (f: AiCleanField) =>
    setDraft((d) => AI_CLEAN_FIELDS.filter((k) => (k === f ? !d.includes(k) : d.includes(k))));

  const run = (picked?: AiCleanField[]) => {
    setOpen(false);
    onRun(picked);
  };

  const summary = fields.length ? fields.map(label).join(", ") : "no fields chosen";
  const sameAsDefault = draft.length === fields.length && draft.every((f) => fields.includes(f));

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <Button
        variant="violet"
        disabled={disabled || fields.length === 0}
        onClick={() => run()}
        title={`AI Clean fills: ${summary}${fillEmptyOnly ? " — empty fields only" : ""}. Change the set in Settings or with the arrow.`}
        className="rounded-r-none"
      >
        <Sparkles />
        AI Clean{backendSuffix}
      </Button>
      <Button
        variant="violet"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Clean only some fields"
        aria-label="Clean only some fields"
        className="rounded-l-none border-l border-white/25 px-1.5"
      >
        <ChevronDown />
      </Button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            className="z-[100] w-72 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ position: "fixed", top: rect.bottom + 4, left: Math.max(8, rect.left) }}
          >
            <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
              Clean only… <span className="font-normal">(click a name to run just that field)</span>
            </p>
            {AI_CLEAN_FIELDS.map((f) => (
              <div key={f} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/60">
                <input
                  type="checkbox"
                  className="accent-[var(--primary)]"
                  checked={draft.includes(f)}
                  onChange={() => toggle(f)}
                  aria-label={`Include ${label(f)}`}
                />
                <button
                  className="min-w-0 flex-1 truncate py-0.5 text-left text-sm hover:text-primary"
                  title={`Clean only ${label(f)} — ${AI_CLEAN_FIELD_HINTS[f]}`}
                  onClick={() => run([f])}
                >
                  Only {label(f)}
                </button>
              </div>
            ))}
            <div className="mt-1 space-y-1 border-t p-1">
              <Button size="sm" className="w-full" disabled={draft.length === 0} onClick={() => run(draft)}>
                Clean ticked fields {draft.length > 0 ? `(${draft.length})` : ""}
              </Button>
              <button
                className="w-full rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 disabled:opacity-50"
                disabled={draft.length === 0 || sameAsDefault}
                onClick={() => onSaveDefault(draft)}
                title="The AI Clean button itself will use the ticked fields from now on"
              >
                {sameAsDefault ? "Ticked fields are the button's default" : "Make ticked fields the default"}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
