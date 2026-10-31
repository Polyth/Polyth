// Personal MCP servers (Spaces §14.6) attach natively only to a runtime that
// serves one chat private to their owner. Native MCP tools live in the harness
// process and cannot be gated per turn, so when such a chat (or the chat it
// follows) stops being private, its runtime must be replaced before anyone
// else drives a turn in it.
//
// Replacement uses the idle-release path: the session runtime is retired only
// under the session lock and only when nothing could be lost (no turn,
// admission, lifecycle flight, transition, open request, queued prompt or
// uncertain operation). The next turn launches a fresh runtime whose
// capability reconcile no longer names the owner's servers, keeping native
// continuity. Until then the chat is "re-provisioning": only its owner may
// start or steer turns.

import { privateSessionOwner } from "./sessionSharing.ts";

export const REPROVISIONING_MESSAGE = "this chat is being re-provisioned after sharing; try again in a moment";

export interface PersonalMcpReprovisionDeps {
  /** May this chat's live runtime carry personal MCP servers? */
  personalMcpLoaded(spaceId: string, sessionId: string): boolean;
  /** The runtime that could carry them is gone. */
  forgetPersonalMcp(spaceId: string, sessionId: string): void;
  /** `SessionService.releaseRuntimeIfIdle`. */
  releaseIfIdle(sessionId: string): Promise<{ released: boolean; blocker?: string }>;
  /** Fallback retry while a chat waits (ms). Status changes retry sooner. */
  retryMs?: number;
}

export interface PersonalMcpReprovisioner {
  /** Chats that stopped being private, each with the person it was private to. */
  leftPrivate(spaceId: string, chats: ReadonlyArray<{ sessionId: string; ownerUserId: string }>): void;
  /** A projection was published; an idle waiting chat is retried. */
  projectionChanged(projection: { id: string; status?: string }): void;
  /** The owner while this chat waits, else undefined. */
  pendingOwner(sessionId: string): string | undefined;
  /** Settles once every in-flight attempt has finished (tests, shutdown). */
  idle(): Promise<void>;
  dispose(): void;
}

let installed: PersonalMcpReprovisioner | undefined;

/** The owner of a chat that is waiting to drop personal MCP servers. */
export function reprovisioningOwner(sessionId: string): string | undefined {
  return installed?.pendingOwner(sessionId);
}

/** Refuse a turn from anyone but the owner while the chat re-provisions. */
export function assertNotReprovisioning(sessionId: string, userId: string | undefined): void {
  const owner = reprovisioningOwner(sessionId);
  if (owner && owner !== userId) throw Object.assign(new Error(REPROVISIONING_MESSAGE), { code: "conflict" });
}

export function createPersonalMcpReprovisioner(deps: PersonalMcpReprovisionDeps): PersonalMcpReprovisioner {
  const pending = new Map<string, { spaceId: string; ownerUserId: string }>();
  const flights = new Map<string, { again: boolean; promise: Promise<void> }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const stopTimerWhenDone = () => {
    if (pending.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const settle = (sessionId: string) => {
    pending.delete(sessionId);
    stopTimerWhenDone();
  };

  const attempt = async (sessionId: string): Promise<void> => {
    const entry = pending.get(sessionId);
    if (!entry || disposed) return;
    // Private to its owner again: the servers belong there.
    if (privateSessionOwner(entry.spaceId, sessionId) === entry.ownerUserId) return settle(sessionId);
    // Released elsewhere (idle sweep, restart, harness switch, delete).
    if (!deps.personalMcpLoaded(entry.spaceId, sessionId)) return settle(sessionId);
    const result = await deps.releaseIfIdle(sessionId);
    if (result.blocker) return;
    deps.forgetPersonalMcp(entry.spaceId, sessionId);
    if (pending.get(sessionId) === entry) settle(sessionId);
    if (result.released) console.log(`[polyth] released ${sessionId} runtime to drop personal MCP servers after sharing`);
  };

  const run = (sessionId: string): Promise<void> => {
    const flight = flights.get(sessionId);
    if (flight) {
      flight.again = true;
      return flight.promise;
    }
    const next = { again: false, promise: Promise.resolve() };
    next.promise = (async () => {
      try {
        do {
          next.again = false;
          try {
            await attempt(sessionId);
          } catch (error) {
            // Kept waiting: the gate stays closed and the timer retries.
            console.warn(`[polyth] re-provisioning ${sessionId} after sharing failed`, error);
          }
        } while (next.again && pending.has(sessionId) && !disposed);
      } finally {
        flights.delete(sessionId);
      }
    })();
    flights.set(sessionId, next);
    return next.promise;
  };

  const service: PersonalMcpReprovisioner = {
    leftPrivate(spaceId, chats) {
      if (disposed) return;
      for (const { sessionId, ownerUserId } of chats) {
        if (!deps.personalMcpLoaded(spaceId, sessionId)) continue;
        // Recorded synchronously, before the sharing change answers, so no
        // other person's turn can be admitted in between.
        pending.set(sessionId, { spaceId, ownerUserId });
        void run(sessionId);
      }
      if (pending.size > 0 && !timer) {
        timer = setInterval(() => {
          for (const sessionId of pending.keys()) void run(sessionId);
        }, deps.retryMs ?? 5_000);
        timer.unref?.();
      }
    },
    projectionChanged(projection) {
      if (!pending.has(projection.id) || projection.status !== "idle") return;
      void run(projection.id);
    },
    pendingOwner: (sessionId) => pending.get(sessionId)?.ownerUserId,
    async idle() {
      while (flights.size > 0) await Promise.allSettled([...flights.values()].map((flight) => flight.promise));
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      pending.clear();
      if (installed === service) installed = undefined;
    },
  };
  installed = service;
  return service;
}
