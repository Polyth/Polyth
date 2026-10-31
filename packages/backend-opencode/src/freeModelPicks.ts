import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { modelUnavailableOf, providerLimitOf, type OcEvent } from "./events.ts";
import {
  calibrateRatings,
  expectedSeconds,
  matchArena,
  sharedFreeModelEvidence,
  type ArenaEntry,
  type EvalResult,
  type FreeModelEvidence,
  type SpeedSample,
} from "./freeModelEvidence.ts";

/**
 * Free-model auto-pick: three virtual catalog rows (`polyth-free/fastest`,
 * `polyth-free/balanced`, `polyth-free/smartest`) that the OpenCode facade
 * resolves to one concrete zero-cost model when a turn starts. The pool is
 * only what the live catalog serves for free right now.
 *
 * The ranking reads no model names. Speed is a measured test response (time
 * to first token plus generation rate); intelligence is the LMArena text
 * rating, or for a model LMArena does not list, a rating predicted from the
 * same verifiable test every free model takes (see freeModelEvidence.ts).
 * A model without the evidence a mode needs ranks after every model that has
 * it, in OpenCode's own order. Failures seen on real turns lower reliability,
 * and a rate-limited or refused model cools down so the next turn routes
 * around it.
 */

export const FREE_PICK_PROVIDER_ID = "polyth-free";
export const FREE_PICK_MODES = ["fastest", "balanced", "smartest"] as const;
export type FreePickMode = (typeof FREE_PICK_MODES)[number];
/** Listed order. An unchosen route takes the first visible row, so Balanced
 *  leads: it is the intended default for a free-only account. */
const PICK_ORDER: readonly FreePickMode[] = ["balanced", "fastest", "smartest"];

const MODE_LABEL: Record<FreePickMode, string> = {
  fastest: "Fastest",
  balanced: "Balanced",
  smartest: "Smartest",
};

/** The row label is only the mode. The concrete free model is chosen when a
 *  turn starts and can differ from the one ranked at listing time, so a model
 *  name here would make the picker lie. */
const pickName = (mode: FreePickMode): string => MODE_LABEL[mode];

/** The group already says "free"; naming OpenCode also gives the rows its
 *  provider mark, since only OpenCode's own catalog is ever picked from. */
const PICK_PROVIDER_NAME = "OpenCode · Free auto-pick";

export const freePickMode = (
  ref: Pick<ModelRef, "providerID" | "modelID"> | undefined,
): FreePickMode | undefined =>
  ref?.providerID === FREE_PICK_PROVIDER_ID
  && (FREE_PICK_MODES as readonly string[]).includes(ref.modelID)
    ? ref.modelID as FreePickMode
    : undefined;

/** Zero list price on a provider that serves it, and able to call tools
 *  (OpenCode is an agent: a model without tools cannot do the work). Unknown
 *  capabilities are not proof of absence. */
export const isFreeModel = (model: ModelDescriptor): boolean =>
  model.providerID !== FREE_PICK_PROVIDER_ID
  && model.connected !== false
  && model.cost !== undefined
  && model.cost.input === 0
  && model.cost.output === 0
  && (model.capabilities === undefined || model.capabilities.includes("toolcall"));

const VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Fastest asks for the least reasoning the model offers, smartest for the
 *  most; balanced keeps the backend's own default. */
export const variantFor = (mode: FreePickMode, model: ModelDescriptor): string | undefined => {
  if (mode === "balanced") return undefined;
  const known = (model.variants ?? [])
    .filter((variant) => VARIANT_ORDER.includes(variant))
    .sort((a, b) => VARIANT_ORDER.indexOf(a) - VARIANT_ORDER.indexOf(b));
  return mode === "fastest" ? known[0] : known.at(-1);
};

interface ModelStats {
  successes: number;
  failures: number;
  coolUntil?: number;
}

export interface FreePickIntelligence {
  rating: number;
  /** `arena`: the leaderboard lists this model; `test`: predicted from the
   *  own test, calibrated on models that have both. */
  source: "arena" | "test";
  arenaName?: string;
  accuracy?: number;
}

export interface FreePickRanking {
  model: ModelDescriptor;
  score: number;
  speed?: SpeedSample;
  /** Seconds for a reference answer: TTFT plus its tokens at the measured rate. */
  expectedSeconds?: number;
  intelligence?: FreePickIntelligence;
  evaluation?: EvalResult;
  /** Whether the evidence this mode needs exists for the model. */
  measured: boolean;
  reliability: number;
  coolingDown: boolean;
}

export interface FreePickResolution {
  mode: FreePickMode;
  model: ModelRef;
  descriptor: ModelDescriptor;
  /** False when no model had the evidence and OpenCode's order decided. */
  measured: boolean;
}

export interface FreeModelPicker {
  /** Remember the live catalog and append one virtual row per mode when at
   *  least one free model is served. */
  withPicks(models: ModelDescriptor[]): ModelDescriptor[];
  /** Age of the remembered catalog in ms; Infinity before the first one. */
  catalogAge(): number;
  /**
   * Gather evidence a mode needs. Resolves once what the mode ranks by is
   * present (or `waitMs` passes); slow, refreshable work keeps running.
   */
  prepare(mode: FreePickMode, waitMs: number): Promise<void>;
  rank(mode: FreePickMode): FreePickRanking[];
  /** The concrete model a virtual ref routes to now, or undefined when the
   *  ref is not a pick or no free model is served. */
  resolve(ref: ModelRef | undefined): FreePickResolution | undefined;
  recordSuccess(model: Pick<ModelRef, "providerID" | "modelID">): void;
  /** A failed step lowers reliability; `coolDownMs` also keeps the model out
   *  of the pool while another one exists. */
  recordFailure(model: Pick<ModelRef, "providerID" | "modelID">, coolDownMs?: number): void;
  /** A provider limit is a wait, not a defect: cool down, keep reliability. */
  recordLimit(model: Pick<ModelRef, "providerID" | "modelID">, coolDownMs: number): void;
}

/** 0.1 (worst in the pool) … 1 (best); never zero, so one weak axis lowers
 *  a balanced score without erasing it. */
const spread = (value: number, values: readonly number[]): number => {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return high > low ? 0.1 + 0.9 * (value - low) / (high - low) : 1;
};

const keyOf = (model: Pick<ModelRef, "providerID" | "modelID">): string =>
  `${model.providerID}/${model.modelID}`;

/** Wait for `work`, at most `ms`; the timer never outlives the wait. */
const boundedWait = async (work: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

export interface FreePickMeasurements {
  /** One test response through OpenCode, timed from its events. */
  measureSpeed(model: ModelRef): Promise<SpeedSample>;
  /** The fixed task set through OpenCode, graded. */
  evaluate(model: ModelRef): Promise<EvalResult>;
}

export const createFreeModelPicker = (
  options: { now?: () => number; evidence?: FreeModelEvidence; measurements?: FreePickMeasurements } = {},
): FreeModelPicker => {
  const now = options.now ?? Date.now;
  const evidence = options.evidence ?? sharedFreeModelEvidence();
  const measurements = options.measurements;
  const stats = new Map<string, ModelStats>();
  let catalog: ModelDescriptor[] = [];
  let catalogAt: number | undefined;

  const statsFor = (model: Pick<ModelRef, "providerID" | "modelID">): ModelStats => {
    const key = keyOf(model);
    let entry = stats.get(key);
    if (!entry) {
      entry = { successes: 0, failures: 0 };
      stats.set(key, entry);
    }
    return entry;
  };

  const pool = (): ModelDescriptor[] => {
    const seen = new Set<string>();
    return catalog.filter((model) => {
      if (!isFreeModel(model)) return false;
      const key = keyOf(model);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const intelligenceOf = (models: readonly ModelDescriptor[]): Map<string, FreePickIntelligence> => {
    const arena: readonly ArenaEntry[] = evidence.arena() ?? [];
    const result = new Map<string, FreePickIntelligence>();
    const points: Array<{ rating: number; accuracy: number }> = [];
    for (const model of models) {
      const match = matchArena(model, arena);
      const evaluation = evidence.evaluation(model);
      if (match) {
        result.set(keyOf(model), {
          rating: match.entry.rating, source: "arena", arenaName: match.entry.name,
          ...(evaluation ? { accuracy: evaluation.accuracy } : {}),
        });
        if (evaluation) points.push({ rating: match.entry.rating, accuracy: evaluation.accuracy });
      }
    }
    const predict = calibrateRatings(points);
    if (predict) {
      for (const model of models) {
        if (result.has(keyOf(model))) continue;
        const evaluation = evidence.evaluation(model);
        const rating = evaluation ? predict(evaluation.accuracy) : undefined;
        if (evaluation && rating !== undefined) {
          result.set(keyOf(model), { rating, source: "test", accuracy: evaluation.accuracy });
        }
      }
    }
    return result;
  };

  const rank = (mode: FreePickMode): FreePickRanking[] => {
    const at = now();
    const models = pool();
    const intelligence = intelligenceOf(models);
    const rows = models.map((model, index) => {
      const speed = evidence.speed(model);
      const evaluation = evidence.evaluation(model);
      const entry = stats.get(keyOf(model));
      const successes = entry?.successes ?? 0;
      const failures = entry?.failures ?? 0;
      const smart = intelligence.get(keyOf(model));
      return {
        model,
        index,
        ...(speed ? { speed, expectedSeconds: expectedSeconds(speed) } : {}),
        ...(smart ? { intelligence: smart } : {}),
        ...(evaluation ? { evaluation } : {}),
        reliability: (successes + 3) / (successes + failures + 3),
        coolingDown: entry?.coolUntil !== undefined && entry.coolUntil > at,
        measured: false,
        score: 0,
      };
    });
    const timed = rows.filter((row) => row.expectedSeconds !== undefined);
    const rated = rows.filter((row) => row.intelligence !== undefined);
    const fastestTime = Math.min(...timed.map((row) => row.expectedSeconds!));
    const speeds = timed.map((row) => 1 / row.expectedSeconds!);
    const ratings = rated.map((row) => row.intelligence!.rating);
    for (const row of rows) {
      const time = row.expectedSeconds;
      const rating = row.intelligence?.rating;
      if (mode === "fastest" && time !== undefined) {
        row.measured = true;
        row.score = (fastestTime / time) * row.reliability;
      } else if (mode === "smartest" && rating !== undefined) {
        row.measured = true;
        row.score = spread(rating, ratings) * row.reliability;
      } else if (mode === "balanced" && time !== undefined && rating !== undefined) {
        row.measured = true;
        row.score = Math.sqrt(spread(1 / time, speeds) * spread(rating, ratings)) * row.reliability;
      }
    }
    // A model cooling down ranks below every usable one but still ranks:
    // when the whole pool is limited, the best of it is still the answer.
    return rows
      .sort((a, b) => Number(a.coolingDown) - Number(b.coolingDown)
        || Number(b.measured) - Number(a.measured)
        || b.score - a.score
        || a.index - b.index)
      .map(({ index: _index, ...row }) => row);
  };

  const resolve = (ref: ModelRef | undefined): FreePickResolution | undefined => {
    const mode = freePickMode(ref);
    if (!mode) return undefined;
    const best = rank(mode)[0];
    if (!best) return undefined;
    const variant = variantFor(mode, best.model);
    return {
      mode,
      descriptor: best.model,
      measured: best.measured,
      model: { providerID: best.model.providerID, modelID: best.model.modelID, ...(variant ? { variant } : {}) },
    };
  };

  const refresh = (mode: FreePickMode): { needed: Promise<void>; background: Promise<void> } => {
    const targets = pool().map((model) => ({ providerID: model.providerID, modelID: model.modelID }));
    const done = Promise.resolve();
    const speed = mode === "smartest" || !measurements ? done
      : evidence.refreshSpeed(targets, (model) => measurements.measureSpeed(model));
    const arena = mode === "fastest" ? done : evidence.refreshArena();
    const tests = mode === "fastest" || !measurements ? done
      : evidence.refreshEvaluations(targets, (model) => measurements.evaluate(model));
    return { needed: Promise.all([speed, arena]).then(() => {}), background: tests };
  };

  return {
    withPicks(models) {
      catalog = models.filter((model) => model.providerID !== FREE_PICK_PROVIDER_ID);
      catalogAt = now();
      const picks = PICK_ORDER.flatMap((mode): ModelDescriptor[] => {
        const best = rank(mode)[0]?.model;
        if (!best) return [];
        return [{
          providerID: FREE_PICK_PROVIDER_ID,
          modelID: mode,
          name: pickName(mode),
          providerName: PICK_PROVIDER_NAME,
          ...(best.context !== undefined ? { context: best.context } : {}),
          cost: { input: 0, output: 0 },
          ...(best.capabilities ? { capabilities: [...best.capabilities] } : {}),
          connected: true,
        }];
      });
      // A route with no chosen model falls back to the first visible row. The
      // catalog is already ordered configured providers first, then the free
      // tier, so the picks go right before the free tier: an account with only
      // free models starts on Balanced instead of one arbitrary free model,
      // while any configured (usually paid) model still comes first. When the
      // picks cannot form at all, that first free row stays the fallback —
      // today OpenCode's own order begins it with Big Pickle.
      const insertAt = catalog.findIndex((model) => model.connected === false || isFreeModel(model));
      return insertAt < 0
        ? [...catalog, ...picks]
        : [...catalog.slice(0, insertAt), ...picks, ...catalog.slice(insertAt)];
    },
    catalogAge: () => catalogAt === undefined ? Number.POSITIVE_INFINITY : now() - catalogAt,
    async prepare(mode, waitMs) {
      const work = refresh(mode);
      void work.background;
      await boundedWait(work.needed, waitMs);
    },
    rank,
    resolve,
    recordSuccess(model) {
      const entry = statsFor(model);
      entry.successes += 1;
      entry.coolUntil = undefined;
    },
    recordFailure(model, coolDownMs) {
      const entry = statsFor(model);
      entry.failures += 1;
      if (coolDownMs && coolDownMs > 0) entry.coolUntil = Math.max(entry.coolUntil ?? 0, now() + coolDownMs);
    },
    recordLimit(model, coolDownMs) {
      const entry = statsFor(model);
      entry.coolUntil = Math.max(entry.coolUntil ?? 0, now() + coolDownMs);
    },
  };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A rate-limited model sits out at least this long unless the provider says when it resets. */
const LIMIT_COOL_DOWN_MS = 5 * 60_000;
/** A model the provider refused for this account is unlikely to come back soon. */
const UNAVAILABLE_COOL_DOWN_MS = 30 * 60_000;
const MAX_TRACKED_STEPS = 512;

export interface FreeModelUsageObserver {
  /** The concrete model a free pick routed this session's current turn to. */
  routed(sessionId: string, model: ModelRef | undefined): void;
  observe(sessionId: string, event: OcEvent): void;
}

/**
 * Feed a picker's reliability from the native event stream. A completed
 * assistant step counts as a success for the model that ran it; failures are
 * attributed only to a model a pick routed, where the event cannot name a
 * different one. Speed is not taken from real turns: a turn's length depends
 * on its task, so only the fixed test response is comparable across models.
 */
export const createFreeModelUsageObserver = (
  picker: FreeModelPicker,
  options: { now?: () => number } = {},
): FreeModelUsageObserver => {
  const now = options.now ?? Date.now;
  const routedBySession = new Map<string, ModelRef>();
  const steps = new Map<string, { model?: ModelRef; done: boolean }>();

  const step = (id: string) => {
    let entry = steps.get(id);
    if (!entry) {
      entry = { done: false };
      steps.set(id, entry);
      if (steps.size > MAX_TRACKED_STEPS) {
        const oldest = steps.keys().next().value;
        if (oldest !== undefined) steps.delete(oldest);
      }
    }
    return entry;
  };

  return {
    routed(sessionId, model) {
      if (model) routedBySession.set(sessionId, model);
      else routedBySession.delete(sessionId);
    },
    observe(sessionId, event) {
      if (event.type === "message.updated") {
        const info = asRecord(event.properties?.info);
        if (info?.role !== "assistant" || typeof info.id !== "string" || !info.id) return;
        const entry = step(info.id);
        if (entry.done) return;
        // V2 names the model when a step starts, not when it ends.
        if (typeof info.providerID === "string" && info.providerID && typeof info.modelID === "string" && info.modelID) {
          entry.model = { providerID: info.providerID, modelID: info.modelID };
        }
        if (typeof asRecord(info.time)?.completed !== "number") return;
        entry.done = true;
        // A failed step is reported again as session.error with its cause.
        if (info.error || !entry.model) return;
        picker.recordSuccess(entry.model);
        return;
      }
      if (event.type !== "session.error") return;
      const model = routedBySession.get(sessionId);
      if (!model) return;
      const limit = providerLimitOf(event);
      if (limit) {
        const advised = limit.resetAt !== undefined
          ? limit.resetAt - now()
          : limit.retryAfterSec !== undefined ? limit.retryAfterSec * 1000 : 0;
        picker.recordLimit(model, Math.max(advised, LIMIT_COOL_DOWN_MS));
        return;
      }
      picker.recordFailure(model, modelUnavailableOf(event) ? UNAVAILABLE_COOL_DOWN_MS : undefined);
    },
  };
};
