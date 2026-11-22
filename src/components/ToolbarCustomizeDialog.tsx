import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Minus, Pencil, Plus, Settings2, Trash2, Workflow, X } from "lucide-react";
import { Button, cn, inputClass } from "./ui";
import {
  CUSTOM_PREFIX,
  DEFAULT_TOOLBAR_ORDER,
  RAW_PREFIX,
  SEQUENCE_STEPS,
  describeStep,
  fieldName,
  isDivider,
  labelFor,
  normalizeToolbarOrder,
  type CustomFeature,
  type SequenceStep,
} from "../lib/toolbarLayout";
import { AI_CLEAN_FIELDS, CAP_OPTIONS, CLEARABLE_FIELDS, type Capitalization } from "../types";

/**
 * Customize the Library toolbar: reorder and hide feature buttons, and build
 * custom features that run several of them in sequence.
 *
 * Reordering uses up/down buttons, not a drag gesture — HTML5 drag in this
 * webview can start a native content drag that freezes the renderer (see
 * CLAUDE.md), and buttons work with the keyboard too.
 *
 * Nothing is saved until "Save"; Cancel throws the edits away.
 */
export function ToolbarCustomizeDialog({
  order: initialOrder,
  hidden: initialHidden,
  customs: initialCustoms,
  rawKeys,
  onSave,
  onClose,
}: {
  order: string[];
  hidden: string[];
  customs: CustomFeature[];
  /** Extra tag frames on the selected tracks, offered as Clear Fields step targets. */
  rawKeys: string[];
  onSave: (v: { toolbarOrder: string[]; toolbarHidden: string[]; customFeatures: CustomFeature[] }) => void;
  onClose: () => void;
}) {
  const [order, setOrder] = useState(initialOrder);
  const [hidden, setHidden] = useState(() => new Set(initialHidden));
  const [customs, setCustoms] = useState(initialCustoms);
  /** The custom feature being edited (a draft; committed into `customs` on Done). */
  const [editing, setEditing] = useState<CustomFeature | null>(null);
  /** Index of the step whose options are open in the editor. */
  const [openStep, setOpenStep] = useState<number | null>(null);

  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const j = i + d;
      if (j < 0 || j >= o.length) return o;
      const n = [...o];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const toggle = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const commitEditing = () => {
    if (!editing) return;
    setOpenStep(null);
    const feature = { ...editing, name: editing.name.trim() || "Custom feature" };
    const next = customs.some((c) => c.id === feature.id)
      ? customs.map((c) => (c.id === feature.id ? feature : c))
      : [...customs, feature];
    setCustoms(next);
    setOrder((o) => normalizeToolbarOrder(o, next));
    setEditing(null);
  };
  const removeCustom = (id: string) => {
    const next = customs.filter((c) => c.id !== id);
    setCustoms(next);
    setOrder((o) => normalizeToolbarOrder(o, next));
  };

  if (editing) {
    return (
      <Shell title={customs.some((c) => c.id === editing.id) ? "Edit custom feature" : "New custom feature"} onClose={() => setEditing(null)}>
        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <input
          autoFocus
          className={cn(inputClass, "mb-3 mt-1 w-full")}
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          placeholder="e.g. Quick clean"
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Steps (run top to bottom)</div>
            <div className="min-h-40 rounded-md border p-1">
              {editing.steps.length === 0 && (
                <div className="p-3 text-xs text-muted-foreground">Add features from the right.</div>
              )}
              {editing.steps.map((s, i) => (
                <div key={i}>
                <div className="flex items-center gap-1 rounded px-1.5 py-1 text-sm hover:bg-accent/50">
                  <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span>
                  <span className="flex-1 truncate" title={describeStep(s)}>{describeStep(s)}</span>
                  {SEQUENCE_STEPS[s.kind]?.options && (
                    <IconBtn
                      title="Options for this step"
                      active={openStep === i}
                      onClick={() => setOpenStep(openStep === i ? null : i)}
                    >
                      <Settings2 />
                    </IconBtn>
                  )}
                  <IconBtn
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => {
                      setEditing({ ...editing, steps: swap(editing.steps, i, i - 1) });
                      setOpenStep(null);
                    }}
                  >
                    <ArrowUp />
                  </IconBtn>
                  <IconBtn
                    title="Move down"
                    disabled={i === editing.steps.length - 1}
                    onClick={() => {
                      setEditing({ ...editing, steps: swap(editing.steps, i, i + 1) });
                      setOpenStep(null);
                    }}
                  >
                    <ArrowDown />
                  </IconBtn>
                  <IconBtn
                    title="Remove step"
                    onClick={() => {
                      setEditing({ ...editing, steps: editing.steps.filter((_, k) => k !== i) });
                      setOpenStep(null);
                    }}
                  >
                    <Minus />
                  </IconBtn>
                </div>
                {openStep === i && (
                  <StepOptions
                    step={s}
                    rawKeys={rawKeys}
                    onChange={(next) =>
                      setEditing({ ...editing, steps: editing.steps.map((x, k) => (k === i ? next : x)) })
                    }
                  />
                )}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Available features</div>
            <div className="rounded-md border p-1">
              {Object.entries(SEQUENCE_STEPS).map(([id, def]) => (
                <button
                  key={id}
                  onClick={() => {
                    setEditing({ ...editing, steps: [...editing.steps, { kind: id }] });
                    // Open the options of a step that has some, so they're discoverable.
                    setOpenStep(def.options ? editing.steps.length : null);
                  }}
                  disabled={editing.steps.length >= 50}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
                >
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                  {def.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={editing.review}
            onChange={(e) => setEditing({ ...editing, review: e.target.checked })}
          />
          <span>
            Pause to review each preview
            <span className="block text-xs text-muted-foreground">
              Off: previews (Capitalization, Characters, AI Clean…) are applied automatically so the next step builds on
              them — every step can still be undone in History. On: the run waits until you Apply (or Cancel to skip).
            </span>
          </span>
        </label>
        {editing.steps.some((x) => x.kind === "rename") && editing.steps[editing.steps.length - 1]?.kind !== "rename" && (
          <p className="mt-2 text-xs text-amber-500">Tip: put Rename to Standard last — it changes the file names.</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Steps with <Settings2 className="inline h-3 w-3" /> have their own options; left unset they use your
          Settings. Dialog-only features (Convert, Stems, Find Art…) can't be chained.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(null)}>
            Back
          </Button>
          <Button onClick={commitEditing} disabled={editing.steps.length === 0}>
            Done
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Customize toolbar" onClose={onClose}>
      <p className="mb-2 text-xs text-muted-foreground">
        Reorder with the arrows, hide with the eye. Undo / Redo / History stay at the left.
      </p>
      <div className="max-h-[52vh] overflow-y-auto rounded-md border p-1">
        {order.map((id, i) => {
          const isHidden = hidden.has(id);
          const custom = id.startsWith(CUSTOM_PREFIX) ? customs.find((c) => CUSTOM_PREFIX + c.id === id) : undefined;
          return (
            <div
              key={id}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-1 text-sm hover:bg-accent/50",
                isHidden && "opacity-45",
              )}
            >
              {custom && <Workflow className="h-3.5 w-3.5 text-primary" />}
              <span className={cn("flex-1 truncate", isDivider(id) && "text-xs italic text-muted-foreground")}>
                {isDivider(id) ? "── divider ──" : labelFor(id, customs)}
                {custom && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {custom.steps.map(describeStep).join(" → ")}
                  </span>
                )}
              </span>
              {custom && (
                <>
                  <IconBtn title="Edit" onClick={() => setEditing({ ...custom, steps: [...custom.steps] })}>
                    <Pencil />
                  </IconBtn>
                  <IconBtn title="Delete custom feature" onClick={() => removeCustom(custom.id)}>
                    <Trash2 />
                  </IconBtn>
                </>
              )}
              <IconBtn title={isHidden ? "Show" : "Hide"} onClick={() => toggle(id)}>
                {isHidden ? <EyeOff /> : <Eye />}
              </IconBtn>
              <IconBtn title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </IconBtn>
              <IconBtn title="Move down" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown />
              </IconBtn>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setEditing({ id: crypto.randomUUID(), name: "", steps: [], review: false })}
        >
          <Workflow />
          New custom feature
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOrder(normalizeToolbarOrder(DEFAULT_TOOLBAR_ORDER, customs));
            setHidden(new Set());
          }}
          title="Default order, everything shown (custom features are kept, at the end)"
        >
          Reset
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            // Drop hidden ids that no longer exist (a deleted custom feature).
            const ids = new Set(order);
            onSave({ toolbarOrder: order, toolbarHidden: [...hidden].filter((h) => ids.has(h)), customFeatures: customs });
            onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Shell>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const n = [...a];
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border bg-card p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [&_svg]:h-3.5 [&_svg]:w-3.5",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Per-step options. Anything left unset means "use Settings", so a feature
 * built before the option existed keeps doing what it did.
 */
function StepOptions({
  step,
  rawKeys,
  onChange,
}: {
  step: SequenceStep;
  rawKeys: string[];
  onChange: (s: SequenceStep) => void;
}) {
  const kind = SEQUENCE_STEPS[step.kind]?.options;
  const fields = step.fields ?? [];
  const toggle = (f: string) =>
    onChange({ ...step, fields: fields.includes(f) ? fields.filter((x) => x !== f) : [...fields, f] });
  const box = "ml-6 mb-1.5 rounded-md border bg-muted/30 p-2 text-xs";

  if (kind === "capitalization") {
    return (
      <div className={box}>
        <label className="flex items-center gap-2">
          Mode
          <select
            className={cn(inputClass, "h-7 py-0 text-xs")}
            value={step.capitalization ?? ""}
            onChange={(e) =>
              onChange({ ...step, capitalization: (e.target.value || undefined) as Capitalization | undefined })
            }
          >
            <option value="">Use Settings</option>
            {CAP_OPTIONS.filter((o) => o.value !== "asis").map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (kind === "aiClean") {
    return (
      <div className={box}>
        <div className="mb-1 text-muted-foreground">Fields to look up (none ticked = use Settings)</div>
        <div className="grid grid-cols-2 gap-x-3">
          {AI_CLEAN_FIELDS.map((f) => (
            <Check key={f} label={fieldName(f)} checked={fields.includes(f)} onChange={() => toggle(f)} />
          ))}
        </div>
      </div>
    );
  }

  if (kind === "clearFields") {
    const keep = step.clearMode === "keep";
    // Raw frames already picked stay listed even when the current selection lacks them.
    const raw = [...new Set([...rawKeys.map((k) => RAW_PREFIX + k), ...fields.filter((f) => f.startsWith(RAW_PREFIX))])];
    return (
      <div className={box}>
        <div className="mb-1.5 flex gap-3">
          <label className="flex items-center gap-1">
            <input type="radio" checked={!keep} onChange={() => onChange({ ...step, clearMode: "clear" })} />
            Clear these
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={keep} onChange={() => onChange({ ...step, clearMode: "keep" })} />
            Keep these, clear the rest
          </label>
        </div>
        <div className="grid max-h-44 grid-cols-2 gap-x-3 overflow-y-auto">
          {CLEARABLE_FIELDS.map((f) => (
            <Check key={f} label={fieldName(f)} checked={fields.includes(f)} onChange={() => toggle(f)} />
          ))}
          {raw.map((f) => (
            <Check key={f} label={fieldName(f)} mono checked={fields.includes(f)} onChange={() => toggle(f)} />
          ))}
        </div>
        <div className="mt-1.5 text-muted-foreground">
          {keep
            ? "Every other clearable field and extra tag frame on the tracks is cleared. Title, Artist, BPM, Key and Rating always stay."
            : "Nothing ticked = use the Clear Fields picks from the toolbar."}
          {raw.length === 0 && " Select tracks first to also see their extra tag frames here."}
        </div>
      </div>
    );
  }
  return null;
}

function Check({
  label,
  checked,
  mono,
  onChange,
}: {
  label: string;
  checked: boolean;
  mono?: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-1.5 truncate py-0.5">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className={cn("truncate", mono && "font-mono text-[11px]")}>{label}</span>
    </label>
  );
}
