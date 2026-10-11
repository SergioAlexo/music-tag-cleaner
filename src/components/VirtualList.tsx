import { useEffect, useRef, useState } from "react";
import { cn } from "./ui";

/**
 * Fixed-row-height windowed list: only the rows near the viewport exist in the
 * DOM, with spacers standing in for the rest. The sidebar's album list and
 * library search results are one row per library track/album, and 4000+ of
 * those as real elements is exactly what CLAUDE.md warns against.
 *
 * (`useVirtualRows` is table-shaped — it measures a `tbody tr` — so this is a
 * separate, deliberately tiny list version.)
 */
export function VirtualList({
  count,
  rowHeight,
  renderRow,
  resetKey,
  overscan = 6,
  className,
}: {
  count: number;
  /** Every row must be exactly this tall (px). */
  rowHeight: number;
  renderRow: (index: number) => React.ReactNode;
  /** Scrolls back to the top when this changes (a new query, a new facet). */
  resetKey?: string;
  overscan?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The first visible row, not scrollTop: React skips a setState to an
  // unchanged value, so scrolling within a row costs no render.
  const [first, setFirst] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      setFirst(Math.floor(el.scrollTop / rowHeight));
      setViewport(el.clientHeight);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [rowHeight]);

  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + Math.ceil(viewport / rowHeight) + 1 + overscan);
  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) rows.push(renderRow(i));

  return (
    <div ref={ref} className={cn("min-h-0 flex-1 overflow-y-auto", className)}>
      <div style={{ height: start * rowHeight }} />
      {rows}
      <div style={{ height: Math.max(0, (count - end) * rowHeight) }} />
    </div>
  );
}
