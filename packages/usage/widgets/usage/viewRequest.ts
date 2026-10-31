/** A one-shot request for the dashboard to show a view, e.g. from an alert's "Open limits". */
export type RequestedUsageView = "session" | "project" | "global" | "limits";

let pending: RequestedUsageView | null = null;
const listeners = new Set<() => void>();

export function requestUsageView(view: RequestedUsageView): void {
  pending = view;
  for (const listener of listeners) listener();
}

/** The pending request, cleared once read. */
export function takeUsageViewRequest(): RequestedUsageView | null {
  const view = pending;
  pending = null;
  return view;
}

export function subscribeUsageViewRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
