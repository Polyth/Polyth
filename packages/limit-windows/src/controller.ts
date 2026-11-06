// Applies the decisions: reads a fresh limit snapshot, sends the one request that
// starts a window, then reads again to see what it did. Every decision comes from
// `decide.ts`; this file owns timing, concurrency and evidence.
//
// A start is written down before its request goes out and is never replayed: after
// a crash or a timeout the next reading says what happened, not a retry.
import { randomUUID } from "node:crypto";
import { decide, judgeStart, VERIFY_DELAY_MS, type Decision, type PingRecord } from "./decide.ts";
import { rankModels, type CatalogModel } from "./models.ts";
import type { PlanModel, WindowPlan } from "./plan.ts";
import type { PlanStore } from "./store.ts";
import { exhaustedUntil, metersOf, phaseOf, type LimitSource, type Meter } from "./windows.ts";

/** Answers once, a cold CLI start included. */
export const PING_TIMEOUT_MS = 120_000;
/** Each request is a CLI process, so two at a time at most on a shared host. */
const MAX_FLIGHTS = 2;
const TICK_MS = 5_000;
/** A decision is revisited this often, so a person's own turn shows up soon. */
const MAX_WAIT_MS = 5 * 60_000;
/** A reading that fails is asked for again this often before the start goes ahead
 *  on the last good one: an unavailable usage endpoint should not hold every
 *  window back, and an extra request on a running window costs next to nothing. */
const READ_RETRY_MS = 30_000;
const MAX_READ_RETRIES = 3;

export interface PingTarget {
  harnessId: string;
  model: PlanModel;
}

export interface ControllerDeps {
  now(): number;
  /** Cached Limits snapshots; never asks a provider. */
  sources(): readonly LimitSource[];
  /** A new provider reading. */
  refresh(sourceId: string): Promise<LimitSource>;
  /** The harness a source's requests run on; undefined if none can reach it. */
  routeOf(source: LimitSource, models: readonly CatalogModel[]): { harnessId: string; models: CatalogModel[] } | undefined;
  /** The live catalog. */
  models(): Promise<readonly CatalogModel[]>;
  /** Whether this plan may still run on this source's current owner. */
  authorized(sourceId: string): boolean;
  send(target: PingTarget, spaceId: string, signal: AbortSignal): Promise<void>;
  store: PlanStore;
  onError?(context: string, error: unknown): void;
}

/** Which model a meter's requests use. */
export function modelFor(plan: WindowPlan, source: LimitSource, meter: Meter, models: readonly CatalogModel[]): { model?: CatalogModel; replaced: boolean; options: CatalogModel[] } {
  const options = rankModels(models, source, meter.primary.id);
  if (plan.model) {
    const chosen = options.find((row) => row.providerID === plan.model!.providerID && row.modelID === plan.model!.modelID);
    if (chosen) return { model: chosen, replaced: false, options };
    return { ...(options[0] ? { model: options[0] } : {}), replaced: true, options };
  }
  return { ...(options[0] ? { model: options[0] } : {}), replaced: false, options };
}

const OFF_PLAN: WindowPlan = { mode: "off", times: [], days: [], lead: 0, rolling: false, timeZone: "UTC" };

const SECRETS = /(bearer|token|key|authorization)([=:\s]+)\S+|[A-Za-z0-9_-]{24,}/gi;
/** CLI stderr can carry paths and tokens; only the gist stays. */
const publicError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(SECRETS, "[redacted]").split("\n")[0]!.slice(0, 200);

export function createWindowController(deps: ControllerDeps) {
  const checks = new Map<string, number>();
  const readFailures = new Map<string, number>();
  const flights = new Map<string, AbortController>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;

  const key = (sourceId: string, meterId: string): string => `${sourceId}\u0000${meterId}`;

  const decisionOf = (sourceId: string, source: LimitSource, meter: Meter): Decision => {
    const stored = deps.store.plan(sourceId);
    return decide({
      // A person's "Start now" needs no plan, and is still read back.
      plan: stored?.plan ?? OFF_PLAN,
      savedAt: stored?.updatedAt ?? 0,
      meter,
      source,
      records: deps.store.records(sourceId, meter.id),
      now: deps.now(),
    });
  };

  const verify = async (sourceId: string, meterId: string, record: PingRecord): Promise<void> => {
    let fresh: LimitSource;
    try {
      fresh = await deps.refresh(sourceId);
    } catch (error) {
      deps.onError?.("verify read", error);
      deps.store.putRecord(sourceId, meterId, { ...record, outcome: "unconfirmed" });
      return;
    }
    deps.store.putRecord(sourceId, meterId, { ...record, ...judgeStart(record, fresh, deps.now()) });
  };

  const fire = async (
    sourceId: string,
    meter: Meter,
    source: LimitSource,
    plan: WindowPlan,
    spaceId: string,
    start: { windowId: string; periodMs: number; reason: PingRecord["reason"]; targetAt?: number },
  ): Promise<PingRecord | { problem: "no-route" | "no-model" }> => {
    const flightKey = key(sourceId, meter.id);
    const models = await deps.models();
    const route = deps.routeOf(source, models);
    if (!route) return { problem: "no-route" };
    const { model } = modelFor(plan, source, meter, route.models);
    if (!model) return { problem: "no-model" };
    const started = deps.now();
    const record: PingRecord = {
      id: randomUUID(),
      at: started,
      windowId: start.windowId,
      periodMs: start.periodMs,
      reason: start.reason,
      ...(start.targetAt !== undefined ? { targetAt: start.targetAt } : {}),
      providerID: model.providerID,
      modelID: model.modelID,
      outcome: "sending",
    };
    deps.store.putRecord(sourceId, meter.id, record);
    const controller = new AbortController();
    flights.set(flightKey, controller);
    try {
      await deps.send({ harnessId: route.harnessId, model: { providerID: model.providerID, modelID: model.modelID } }, spaceId, controller.signal);
      const sent: PingRecord = { ...record, outcome: "sent", latencyMs: deps.now() - started };
      deps.store.putRecord(sourceId, meter.id, sent);
      return sent;
    } catch (error) {
      // An empty answer is still an answer: the request reached the model.
      if ((error as { code?: unknown } | null)?.code === "invalid-response") {
        const sent: PingRecord = { ...record, outcome: "sent", latencyMs: deps.now() - started };
        deps.store.putRecord(sourceId, meter.id, sent);
        return sent;
      }
      const failed: PingRecord = { ...record, outcome: "failed", latencyMs: deps.now() - started, error: publicError(error) };
      deps.store.putRecord(sourceId, meter.id, failed);
      deps.onError?.("start", error);
      return failed;
    } finally {
      flights.delete(flightKey);
      // Its reading comes due on its own clock, not on a check set before it.
      checks.delete(flightKey);
    }
  };

  const step = async (sourceId: string, source: LimitSource, meter: Meter): Promise<void> => {
    const flightKey = key(sourceId, meter.id);
    if (flights.has(flightKey)) return;
    if (deps.now() < (checks.get(flightKey) ?? 0)) return;

    const decision = decisionOf(sourceId, source, meter);
    if (decision.kind === "off") {
      checks.set(flightKey, deps.now() + MAX_WAIT_MS);
      return;
    }
    if (decision.kind === "verify") {
      if (deps.now() < decision.at) {
        checks.set(flightKey, decision.at);
        return;
      }
      await verify(sourceId, meter.id, decision.record);
      return;
    }
    if (decision.kind === "wait") {
      checks.set(flightKey, Math.min(decision.at, deps.now() + MAX_WAIT_MS));
      return;
    }

    // Reading back was harmless; from here a request can go out.
    const stored = deps.store.plan(sourceId);
    if (!stored || !deps.authorized(sourceId)) {
      checks.set(flightKey, deps.now() + MAX_WAIT_MS);
      return;
    }

    // Due. Only a new reading may start a window: a person's turn may have.
    const fresh = await deps.refresh(sourceId).catch((error: unknown) => {
      deps.onError?.("read", error);
      return undefined;
    });
    if (!fresh || fresh.stale) {
      const failures = (readFailures.get(flightKey) ?? 0) + 1;
      if (failures <= MAX_READ_RETRIES) {
        readFailures.set(flightKey, failures);
        checks.set(flightKey, deps.now() + READ_RETRY_MS);
        return;
      }
    }
    readFailures.delete(flightKey);
    const reading = fresh ?? source;
    const current = metersOf(reading).find((row) => row.id === meter.id);
    if (!current) return;
    const confirmed = decisionOf(sourceId, reading, current);
    if (confirmed.kind !== "ping") {
      checks.set(flightKey, confirmed.kind === "wait" ? Math.min(confirmed.at, deps.now() + MAX_WAIT_MS) : deps.now() + MAX_WAIT_MS);
      return;
    }
    const outcome = await fire(sourceId, current, reading, stored.plan, stored.spaceId, {
      windowId: confirmed.window.id,
      periodMs: confirmed.window.periodMs ?? 0,
      reason: confirmed.start.reason,
      ...(confirmed.start.targetAt !== undefined ? { targetAt: confirmed.start.targetAt } : {}),
    });
    // Nowhere to send it: look again once the catalog or the login may differ.
    if ("problem" in outcome) checks.set(flightKey, deps.now() + MAX_WAIT_MS);
  };

  const tick = async (): Promise<void> => {
    const sources = deps.sources();
    const work: Array<() => Promise<void>> = [];
    for (const source of sources) {
      for (const meter of metersOf(source)) work.push(() => step(source.providerId, source, meter));
    }
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < work.length) {
        const job = work[next++]!;
        await job().catch((error: unknown) => deps.onError?.("step", error));
      }
    };
    await Promise.all(Array.from({ length: MAX_FLIGHTS }, lane));
  };

  return {
    /** One pass; concurrent callers share it. */
    tick(): Promise<void> {
      ticking ??= tick().finally(() => { ticking = undefined; });
      return ticking;
    },
    start(): void {
      timer ??= setInterval(() => { void this.tick(); }, TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const controller of flights.values()) {
        controller.abort(Object.assign(new Error("Limit windows was disabled"), { code: "aborted" }));
      }
    },
    busy: (sourceId: string, meterId: string): boolean => flights.has(key(sourceId, meterId)),
    /** Revisit a meter now, after its plan changed. */
    touch(sourceId: string): void {
      for (const existing of [...checks.keys()]) if (existing.startsWith(`${sourceId}\u0000`)) checks.delete(existing);
      void this.tick();
    },
    /** A person's "Start now". The same reading, evidence and never-replay rules;
     *  only the schedule is skipped. */
    async startNow(sourceId: string, meterId: string, spaceId: string): Promise<PingRecord | { problem: string }> {
      const stored = deps.store.plan(sourceId);
      const flightKey = key(sourceId, meterId);
      if (flights.has(flightKey)) return { problem: "busy" };
      const fresh = await deps.refresh(sourceId);
      const meter = metersOf(fresh).find((row) => row.id === meterId);
      if (!meter) return { problem: "not-found" };
      const now = deps.now();
      const last = deps.store.records(sourceId, meterId)[0];
      if (last && (last.outcome === "sending" || last.outcome === "sent") && now < last.at + (last.latencyMs ?? 0) + VERIFY_DELAY_MS) {
        return { problem: "settling" };
      }
      if (exhaustedUntil(meter, now) !== undefined) return { problem: "exhausted" };
      if (phaseOf(meter.primary, fresh.fetchedAt, now) === "running") return { problem: "running" };
      return fire(sourceId, meter, fresh, stored?.plan ?? OFF_PLAN, stored?.spaceId ?? spaceId, {
        windowId: meter.primary.id,
        periodMs: meter.primary.periodMs ?? 0,
        reason: "manual",
      });
    },
  };
}

export type WindowController = ReturnType<typeof createWindowController>;
