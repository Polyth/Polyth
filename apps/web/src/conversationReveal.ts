/** A navigation request, kept only in memory. Canonical history stays untouched. */
export interface ConversationRevealRequest {
  sessionId: string;
  eventSeq: number;
  focus: boolean;
  signal: AbortSignal;
  current(): boolean;
  finish(revealed: boolean): void;
}

type Handler = (request: ConversationRevealRequest) => boolean;
const handlers = new Set<{ sessionId: string; handle: Handler }>();
let pending: ConversationRevealRequest | null = null;

function dispatch(request: ConversationRevealRequest): void {
  if (!request.current()) { request.finish(false); return; }
  // A newly mounted visible conversation owns navigation over a stale mount.
  for (const entry of [...handlers].reverse()) {
    if (entry.sessionId === request.sessionId && entry.handle(request)) return;
  }
}

export function registerConversationReveal(sessionId: string, handle: Handler): () => void {
  const entry = { sessionId, handle };
  handlers.add(entry);
  if (pending?.sessionId === sessionId) dispatch(pending);
  return () => { handlers.delete(entry); };
}

export function requestConversationReveal(
  sessionId: string,
  eventSeq: number,
  options: { focus?: boolean; signal?: AbortSignal; current?: () => boolean } = {},
): Promise<boolean> {
  if (!sessionId || !Number.isSafeInteger(eventSeq) || eventSeq < 1 || options.signal?.aborted) {
    return Promise.resolve(false);
  }
  pending?.finish(false);
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const timeout = setTimeout(() => request.finish(false), 30_000);
    const abort = () => request.finish(false);
    const request: ConversationRevealRequest = {
      sessionId, eventSeq, signal: controller.signal, focus: options.focus !== false,
      current: () => !settled && !controller.signal.aborted && (options.current?.() ?? true),
      finish: (revealed) => {
        if (settled) return;
        const accepted = revealed && request.current();
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (pending === request) pending = null;
        controller.abort();
        resolve(accepted);
      },
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    pending = request;
    dispatch(request);
  });
}
