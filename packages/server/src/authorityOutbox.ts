import { channel } from "node:diagnostics_channel";
import type { ControlPlane } from "@polyth/control-plane";
import {
  createOutbox,
  type DeliveryResult,
  type OutboxEvent,
} from "@polyth/control-plane/outbox";
import {
  closeAuthSessionSockets,
  closeAuthUserSessionSockets,
  closeAuthUserSockets,
} from "@polyth/plugins";

export const AUTHORITY_EVENT_CHANNEL = "polyth.control-plane.audit.v1";
const authorityEvents = channel(AUTHORITY_EVENT_CHANNEL);

const SESSION_REVOCATION_ACTIONS = new Set([
  "auth.logout",
  "auth.session-revoked",
]);
const USER_SESSION_REVOCATION_RESOURCE_ACTIONS = new Set([
  "auth.logout-all",
  "auth.password-changed",
  "auth.recovery-used",
  "auth.break-glass-password-reset",
]);
const USER_SESSION_REVOCATION_ACTOR_ACTIONS = new Set([
  "auth.passkey-removed",
  "identity.unlinked",
]);
const USER_AUTHORITY_REVOCATION_ACTIONS = new Set([
  "identity.suspended",
  "identity.offboarding",
  "identity.disabled",
]);

export interface AuthorityOutboxStatus {
  running: boolean;
  inFlight: boolean;
  pending: number;
  blocked: number;
  oldestEventAt: number | null;
  lastResult?: DeliveryResult;
  lastDeliveredEventId?: number;
  lastDeliveredAt?: number;
}

export interface AuthorityOutboxWorker {
  start(): void;
  kick(): void;
  flush(maxEvents?: number): Promise<DeliveryResult[]>;
  status(): AuthorityOutboxStatus;
  stop(): Promise<void>;
}

export interface AuthorityOutboxOptions {
  pollMs?: number;
  maxBatch?: number;
  now?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  deliver?: (event: Readonly<OutboxEvent>) => void | Promise<void>;
  log?: (message: string) => void;
}

/**
 * Apply only revocation semantics encoded by canonical identity mutations.
 * Session-credential changes close browser sessions but deliberately preserve
 * paired-device grants. Account lifecycle revocation closes both. Ordinary
 * audit/resource events never disconnect clients.
 */
export function invalidateAuthoritySockets(event: Readonly<OutboxEvent>): number {
  if (SESSION_REVOCATION_ACTIONS.has(event.action)) {
    return event.resourceId ? closeAuthSessionSockets(event.resourceId) : 0;
  }
  if (USER_SESSION_REVOCATION_RESOURCE_ACTIONS.has(event.action)) {
    return event.resourceId ? closeAuthUserSessionSockets(event.resourceId) : 0;
  }
  if (USER_SESSION_REVOCATION_ACTOR_ACTIONS.has(event.action)) {
    return closeAuthUserSessionSockets(event.actorId);
  }
  if (USER_AUTHORITY_REVOCATION_ACTIONS.has(event.action)) {
    return event.resourceId ? closeAuthUserSockets(event.resourceId) : 0;
  }
  return 0;
}

/**
 * Production-safe local delivery seam for canonical authority events.
 * The durable outbox remains authoritative; diagnostics_channel is only the
 * in-process telemetry surface. Subscribers that persist events must dedupe by
 * installationId + id because delivery is intentionally at-least-once.
 */
export async function publishAuthorityEvent(event: Readonly<OutboxEvent>): Promise<void> {
  invalidateAuthoritySockets(event);
  try {
    authorityEvents.publish(event);
  } catch {
    // Observability subscribers are not allowed to poison the durable stream.
    // They may record their own failure, but the authority event was published
    // to the process-local telemetry surface and must not be retried forever.
  }
}

export function createAuthorityOutboxWorker(
  control: ControlPlane,
  options: AuthorityOutboxOptions = {},
): AuthorityOutboxWorker {
  const pollMs = options.pollMs ?? 1_000;
  const maxBatch = options.maxBatch ?? 64;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 60_000) {
    throw Object.assign(new Error("Invalid authority outbox poll interval"), { code: "invalid-input" });
  }
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > 1_024) {
    throw Object.assign(new Error("Invalid authority outbox batch size"), { code: "invalid-input" });
  }

  const now = options.now ?? Date.now;
  const outbox = createOutbox(control, {
    now,
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
  const deliver = options.deliver ?? publishAuthorityEvent;
  const log = options.log ?? ((message: string) => console.warn(message));

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<DeliveryResult[]> | null = null;
  let lastResult: DeliveryResult | undefined;
  let lastDeliveredEventId: number | undefined;
  let lastDeliveredAt: number | undefined;
  let lastBlockedCount = 0;

  const schedule = (delay: number): void => {
    if (!running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runScheduled();
    }, delay);
    timer.unref?.();
  };

  const flush = (maxEvents = maxBatch): Promise<DeliveryResult[]> => {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_024) {
      return Promise.reject(Object.assign(new Error("Invalid authority outbox flush size"), { code: "invalid-input" }));
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const results: DeliveryResult[] = [];
      for (let i = 0; i < maxEvents; i += 1) {
        let deliveredEvent: Readonly<OutboxEvent> | undefined;
        const result = await outbox.deliverNext(async (event) => {
          deliveredEvent = event;
          await deliver(event);
        });
        results.push(result);
        lastResult = result;
        if (result === "delivered" && deliveredEvent) {
          lastDeliveredEventId = deliveredEvent.id;
          lastDeliveredAt = now();
          continue;
        }
        break;
      }
      return results;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const reportBlocked = (): void => {
    const state = outbox.status();
    if (state.blocked > 0 && state.blocked !== lastBlockedCount) {
      log(`[polyth] canonical authority outbox blocked (${state.blocked} event${state.blocked === 1 ? "" : "s"}); operator retry required`);
    }
    lastBlockedCount = state.blocked;
  };

  const runScheduled = async (): Promise<void> => {
    try {
      const results = await flush();
      reportBlocked();
      const saturated = results.length === maxBatch && results.every((result) => result === "delivered");
      schedule(saturated ? 0 : pollMs);
    } catch {
      log("[polyth] canonical authority outbox worker failed; durable events remain pending for retry");
      schedule(pollMs);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    kick() {
      if (!running) return;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      schedule(0);
    },
    flush,
    status() {
      const durable = outbox.status();
      return {
        running,
        inFlight: inFlight !== null,
        ...durable,
        ...(lastResult ? { lastResult } : {}),
        ...(lastDeliveredEventId !== undefined ? { lastDeliveredEventId } : {}),
        ...(lastDeliveredAt !== undefined ? { lastDeliveredAt } : {}),
      };
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    },
  };
}
