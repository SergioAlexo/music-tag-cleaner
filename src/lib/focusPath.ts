/**
 * "Show in Library": other pages ask the Library track table to select and
 * scroll to a file. The table may not be mounted yet (the page switch happens
 * in the same tick), so the request is parked here and consumed when the table
 * is ready; the event covers the case where it is already mounted.
 */
let pending: string | null = null;
const EVENT = "mtc-focus-path";

export function requestFocusPath(path: string) {
  pending = path;
  window.dispatchEvent(new Event(EVENT));
}

export function takeFocusPath(): string | null {
  const p = pending;
  pending = null;
  return p;
}

export function onFocusPathRequest(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
