import { randomUUID } from "node:crypto";

export type BrowserVaultFillDecision = "allow" | "allow-always" | "deny";
export type BrowserVaultFillOutcome =
  | "allow"
  | "allow-always"
  | "auto-allow"
  | "deny"
  | "timeout"
  | "aborted"
  | "cancelled";

export interface BrowserVaultFillRequest {
  id: string;
  /** Server-issued Space grant; absent only for legacy in-process callers. */
  spaceId?: string;
  browserSessionId: string;
  sessionId: string;
  projectId: string;
  handle: string;
  label: string;
  origin: string;
  selector: string;
  submit: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserVaultFillBroker {
  request(
    input: Omit<BrowserVaultFillRequest, "id" | "createdAt" | "expiresAt">,
    signal?: AbortSignal,
  ): Promise<void>;
  list(browserSessionId?: string): BrowserVaultFillRequest[];
  get(id: string): BrowserVaultFillRequest | null;
  resolve(id: string, decision: BrowserVaultFillDecision): boolean;
  cancelForBrowserSession(browserSessionId: string): void;
  cancelAll(): void;
}

export interface BrowserVaultFillBrokerOptions {
  timeoutMs?: number;
  now?: () => number;
  onRequested?(request: BrowserVaultFillRequest): void | Promise<void>;
  onResolved?(request: BrowserVaultFillRequest, outcome: BrowserVaultFillOutcome): void | Promise<void>;
  /** A persisted, handle+origin+project+Space grant may skip the UI prompt. */
  shouldAutoAllow?(request: BrowserVaultFillRequest): boolean | Promise<boolean>;
}

const failure = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

interface Pending {
  request: BrowserVaultFillRequest;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort(): void;
}

export function createBrowserVaultFillBroker(
  opts: BrowserVaultFillBrokerOptions = {},
): BrowserVaultFillBroker {
  const timeoutMs = Math.max(5_000, Math.min(opts.timeoutMs ?? 120_000, 10 * 60_000));
  const now = opts.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const closedBrowserSessions = new Set<string>();

  const finish = (
    id: string,
    outcome: BrowserVaultFillOutcome,
    error?: Error,
  ): boolean => {
    const item = pending.get(id);
    if (!item) return false;
    pending.delete(id);
    clearTimeout(item.timer);
    item.detachAbort();
    void Promise.resolve(opts.onResolved?.(item.request, outcome)).catch(() => {});
    if (outcome === "allow" || outcome === "allow-always" || outcome === "auto-allow") item.resolve();
    else item.reject(error ?? failure("credential-denied", "Credential fill was denied"));
    return true;
  };

  return {
    async request(input, signal) {
      if (signal?.aborted) throw failure("aborted", "Credential fill was aborted");
      const createdAt = now();
      const request: BrowserVaultFillRequest = {
        ...input,
        id: randomUUID(),
        createdAt,
        expiresAt: createdAt + timeoutMs,
      };

      if (closedBrowserSessions.has(request.browserSessionId)) {
        throw failure(
          "credential-approval-cancelled",
          "Browser session closed before credential approval",
        );
      }
      const autoAllowed = opts.shouldAutoAllow ? await opts.shouldAutoAllow(request) : false;
      if (autoAllowed) {
        await opts.onResolved?.(request, "auto-allow");
        return;
      }
      await opts.onRequested?.(request);
      if (signal?.aborted) throw failure("aborted", "Credential fill was aborted");
      if (closedBrowserSessions.has(request.browserSessionId)) {
        throw failure(
          "credential-approval-cancelled",
          "Browser session closed before credential approval",
        );
      }

      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          finish(
            request.id,
            "aborted",
            failure("aborted", "Credential fill was aborted"),
          );
        };
        const timer = setTimeout(() => {
          finish(
            request.id,
            "timeout",
            failure("credential-approval-timeout", "Credential fill approval timed out"),
          );
        }, timeoutMs);
        timer.unref?.();
        pending.set(request.id, {
          request,
          resolve,
          reject,
          timer,
          detachAbort: () => signal?.removeEventListener("abort", onAbort),
        });
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    list(browserSessionId) {
      return [...pending.values()]
        .map((item) => item.request)
        .filter((request) => !browserSessionId || request.browserSessionId === browserSessionId)
        .map((request) => ({ ...request }));
    },

    get(id) {
      const request = pending.get(id)?.request;
      return request ? { ...request } : null;
    },

    resolve(id, decision) {
      return decision === "allow" || decision === "allow-always"
        ? finish(id, decision)
        : finish(id, "deny", failure("credential-denied", "Credential fill was denied"));
    },

    cancelForBrowserSession(browserSessionId) {
      // Remember only recent closures: the set exists to refuse late fills for
      // a session that just closed, not to index every browser session ever.
      closedBrowserSessions.delete(browserSessionId);
      closedBrowserSessions.add(browserSessionId);
      if (closedBrowserSessions.size > 512) {
        closedBrowserSessions.delete(closedBrowserSessions.values().next().value!);
      }
      for (const [id, item] of [...pending]) {
        if (item.request.browserSessionId !== browserSessionId) continue;
        finish(
          id,
          "cancelled",
          failure("credential-approval-cancelled", "Browser session closed before credential approval"),
        );
      }
    },

    cancelAll() {
      for (const id of [...pending.keys()]) {
        finish(
          id,
          "cancelled",
          failure("credential-approval-cancelled", "Credential approval was cancelled"),
        );
      }
    },
  };
}
