// Evidence for free auto-picks. Nothing here reads quality or speed from a
// model's name: speed is a measured test response (time to first token and
// generation rate), intelligence is the open LMArena text leaderboard
// (CC-BY-4.0, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset)
// and, for models it does not list, a fixed set of verifiable tasks scored the
// same way for every free model and calibrated against that leaderboard.
//
// OpenCode's free tier answers only OpenCode itself, so the test response and
// the task set run as host one-shot turns on the OpenCode runtime (a throwaway
// backend session with durable receipts, never a user's history). The
// leaderboard is a public HTTPS download through the shared outbound policy.
import type { AgentRuntime, ModelRef } from "@polyth/contracts";
import type { OcEvent } from "./events.ts";
import { pinnedHttpRequest, resolvePublicHttpsUrl } from "@polyth/outbound";

export interface EvidenceHttpRequest {
  url: string;
  method: "GET";
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

export type EvidenceHttp = (request: EvidenceHttpRequest) => Promise<{ status: number; text: string }>;

export const publicHttps: EvidenceHttp = async (request) => {
  const resolved = await resolvePublicHttpsUrl(request.url, "public");
  const result = await pinnedHttpRequest(resolved.url, resolved.pin, {
    method: request.method,
    ...(request.headers ? { headers: request.headers } : {}),
    timeoutMs: request.timeoutMs,
    maxBytes: request.maxBytes,
  });
  return { status: result.status, text: result.body.toString("utf8") };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const modelKey = (model: Pick<ModelRef, "providerID" | "modelID">): string =>
  `${model.providerID}/${model.modelID}`;

// ------------------------------------------------------------------ host turns

/** Utility turn purposes the OpenCode facade recognises on a one-shot turn. */
export const SPEED_PROBE_PURPOSE = "free-model-speed-probe";
export const EVAL_PURPOSE = "free-model-evaluation";

export interface FreeModelUtilityTurn {
  cwd: string;
  prompt: string;
  model: ModelRef;
  purpose: string;
  timeoutMs: number;
}

/** Runs one prompt as a host one-shot turn and returns its final text. */
export type FreeModelUtilityRunner = (runtime: AgentRuntime, turn: FreeModelUtilityTurn) => Promise<string>;

let utilityRunner: FreeModelUtilityRunner | undefined;

/** The OpenCode server entry installs the host's one-shot here; without it no
 *  model is measured and picks fall back to OpenCode's own order. */
export const configureFreeModelUtility = (runner: FreeModelUtilityRunner): { dispose(): void } => {
  utilityRunner = runner;
  return { dispose: () => { if (utilityRunner === runner) utilityRunner = undefined; } };
};

export const freeModelUtility = (): FreeModelUtilityRunner | undefined => utilityRunner;

// ------------------------------------------------------------------ speed

export interface SpeedSample {
  /** Turn submitted → first generated token (text or reasoning). */
  ttftMs: number;
  /** Generated tokens per second after the first token, first step only. */
  tokensPerSecond: number;
  outputTokens: number;
  /** `usage`: OpenCode's own count for the step; `chunks`: streamed deltas counted. */
  tokenSource: "usage" | "chunks";
  measuredAt: number;
}

/** Long enough to measure a rate, short and fixed so every model does the same work. */
export const SPEED_PROBE_PROMPT = "Do not use any tools. Count from one to sixty in English words, separated by single spaces. Output only the words.";
export const SPEED_PROBE_TIMEOUT_MS = 120_000;
const MIN_RATE_TOKENS = 8;

/**
 * Times one probe turn from OpenCode's native stream, before Polyth's
 * observation layer coalesces deltas into finished parts (that layer would
 * make every token arrive at once). A text or reasoning delta is a token
 * arrival; the first completed assistant step ends the window, with
 * OpenCode's own output and reasoning token count. A tool call or a second
 * step therefore never stretches the measurement.
 */
export const createSpeedMeter = (submittedAt: number) => {
  let first: number | undefined;
  let last: number | undefined;
  let chunks = 0;
  let usageTokens: number | undefined;
  let stepEnded = false;
  return {
    observe(event: OcEvent, at: number): void {
      if (stepEnded) return;
      const properties = event.properties ?? {};
      if ((event.type === "message.part.delta" || event.type === "message.part.updated")
        && typeof properties.delta === "string" && properties.delta) {
        first ??= at;
        last = at;
        chunks += 1;
        return;
      }
      if (event.type !== "message.updated" || first === undefined) return;
      const info = asRecord(properties.info);
      if (info?.role !== "assistant" || typeof asRecord(info.time)?.completed !== "number") return;
      const tokens = asRecord(info.tokens);
      const count = (typeof tokens?.output === "number" ? tokens.output : 0)
        + (typeof tokens?.reasoning === "number" ? tokens.reasoning : 0);
      if (count > 0) usageTokens = count;
      stepEnded = true;
    },
    sample(measuredAt: number): SpeedSample {
      const tokens = usageTokens ?? chunks;
      if (first === undefined || last === undefined || tokens < MIN_RATE_TOKENS || last <= first) {
        throw Object.assign(new Error("free model probe produced too little output to measure"), { code: "insufficient" });
      }
      return {
        ttftMs: Math.max(0, first - submittedAt),
        // The first token's arrival opens the window, so it is not in the rate.
        tokensPerSecond: (tokens - 1) / ((last - first) / 1000),
        outputTokens: tokens,
        tokenSource: usageTokens !== undefined ? "usage" : "chunks",
        measuredAt,
      };
    },
  };
};

/** Seconds a reference answer of this many tokens would take. */
export const REFERENCE_TOKENS = 500;
export const expectedSeconds = (sample: SpeedSample): number =>
  sample.ttftMs / 1000 + REFERENCE_TOKENS / sample.tokensPerSecond;

// ------------------------------------------------------------------ LMArena

export interface ArenaEntry {
  name: string;
  organization?: string;
  rating: number;
  votes: number;
  publishedAt?: string;
}

const ARENA_PAGE = 100;
const ARENA_MAX_PAGES = 15;
const arenaUrl = (offset: number): string =>
  "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset"
  + `&config=text_style_control&split=latest&offset=${offset}&length=${ARENA_PAGE}`;

/** The current Text (style control) leaderboard, overall category. The
 *  dataset lists every overall row before any other category. */
export async function fetchArenaText(http: EvidenceHttp = publicHttps): Promise<ArenaEntry[]> {
  const entries: ArenaEntry[] = [];
  for (let page = 0; page < ARENA_MAX_PAGES; page += 1) {
    const response = await http({
      url: arenaUrl(page * ARENA_PAGE), method: "GET", headers: { accept: "application/json" },
      timeoutMs: 90_000, maxBytes: 8 * 1024 * 1024,
    });
    if (response.status !== 200) {
      throw Object.assign(new Error(`LMArena rows request failed (${response.status})`), { code: response.status === 429 ? "rate-limited" : "failed" });
    }
    const body = asRecord(JSON.parse(response.text));
    const rows = Array.isArray(body?.rows) ? body.rows : undefined;
    if (!rows) throw Object.assign(new Error("LMArena rows response has no rows"), { code: "invalid-response" });
    let ended = rows.length < ARENA_PAGE;
    for (const item of rows) {
      const row = asRecord(asRecord(item)?.row);
      if (!row) continue;
      if (row.category !== "overall") { ended = true; continue; }
      if (typeof row.model_name !== "string" || !row.model_name || typeof row.rating !== "number" || !Number.isFinite(row.rating)) continue;
      entries.push({
        name: row.model_name,
        ...(typeof row.organization === "string" && row.organization ? { organization: row.organization } : {}),
        rating: row.rating,
        votes: typeof row.vote_count === "number" ? row.vote_count : 0,
        ...(typeof row.leaderboard_publish_date === "string" ? { publishedAt: row.leaderboard_publish_date } : {}),
      });
    }
    if (ended) return entries;
  }
  return entries;
}

const normalizeId = (value: string): string => value.toLowerCase()
  .replace(/\([^)]*\)/g, " ")
  .replace(/[\s_/]+/g, "-")
  .replace(/[^a-z0-9.-]/g, "")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "");

/** Run-configuration tokens LMArena appends to one model's entry: reasoning
 *  effort, weight format, parameter counts and dates. They select a run of
 *  the model, they do not name another one. */
const RUN_TOKENS = new Set(["max", "xhigh", "high", "medium", "low", "minimal", "thinking", "instant", "nvfp4", "fp8", "fp16", "bf16", "int4", "int8"]);
const isRunToken = (token: string): boolean =>
  RUN_TOKENS.has(token) || /^a?\d+(?:\.\d+)?[bmt]$/.test(token) || /^\d{4,8}$/.test(token);

/** Keys an arena entry answers to, least stripped first. */
const arenaKeys = (entry: ArenaEntry): string[] => {
  const keys: string[] = [];
  const base = normalizeId(entry.name).replace(/-non-thinking$/, "");
  const org = entry.organization ? normalizeId(entry.organization) : "";
  const roots = org && base.startsWith(`${org}-`) ? [base, base.slice(org.length + 1)] : [base];
  for (const root of roots) {
    keys.push(root);
    const tokens = root.split("-");
    while (tokens.length > 1 && isRunToken(tokens.at(-1)!)) {
      tokens.pop();
      keys.push(tokens.join("-"));
    }
  }
  return keys;
};

/** Keys a catalog model answers to: its id and display name, without the
 *  trailing "free" OpenCode adds to its zero-cost listing. */
export const catalogKeys = (model: { modelID: string; name: string }): string[] =>
  [...new Set([model.modelID, model.name].map((value) => normalizeId(value).replace(/-free$/, "")).filter(Boolean))];

export interface ArenaMatch { entry: ArenaEntry; exact: boolean }

/** Exact identity after normalization; never a fuzzy or partial match. */
export const matchArena = (
  model: { modelID: string; name: string },
  entries: readonly ArenaEntry[],
): ArenaMatch | undefined => {
  const wanted = new Set(catalogKeys(model));
  let best: { entry: ArenaEntry; depth: number } | undefined;
  for (const entry of entries) {
    const depth = arenaKeys(entry).findIndex((key) => wanted.has(key));
    if (depth < 0) continue;
    if (!best || depth < best.depth || (depth === best.depth && entry.votes > best.entry.votes)) best = { entry, depth };
  }
  return best ? { entry: best.entry, exact: best.depth === 0 } : undefined;
};

// ------------------------------------------------------------------ own test

export interface EvalTask { prompt: string; answer: string }

/**
 * Verifiable, single-answer tasks; every answer was computed, not recalled.
 * They need exact multi-step work (counting, modular arithmetic, big-number
 * digits, language traps), so free models separate instead of all scoring
 * full marks, which would leave nothing to calibrate.
 */
export const EVAL_TASKS: readonly EvalTask[] = [
  { prompt: "How many prime numbers are there between 1000 and 1100 inclusive?", answer: "16" },
  { prompt: "What are the last three digits of 7^2026? Answer with exactly three digits.", answer: "649" },
  { prompt: "How many four-digit positive integers have digits that sum to 20?", answer: "597" },
  { prompt: "How many derangements (permutations with no fixed point) of 7 elements are there?", answer: "1854" },
  { prompt: "How many binary strings of length 15 contain no two adjacent 1s?", answer: "1597" },
  { prompt: "41 people stand in a circle numbered 1 to 41. Counting starts at person 1 and every third person is removed (3, 6, 9, ...), continuing around the circle. What is the number of the last person remaining?", answer: "31" },
  { prompt: "How many subsets of {1, 2, ..., 12}, including the empty set, have an element sum divisible by 5?", answer: "820" },
  { prompt: "What is the sum of the decimal digits of 3^100?", answer: "153" },
  { prompt: "What does this Python print? a = [[0] * 3] * 3; a[0][0] = 1; print(sum(map(sum, a)))", answer: "3" },
  { prompt: "What does this JavaScript expression evaluate to? Give the resulting string without quotes: [1, 2, 3].map(parseInt).join(\",\")", answer: "1,NaN,NaN" },
  { prompt: "Moving only right or up one unit at a time, how many shortest lattice paths go from (0,0) to (6,6) without passing through the point (3,3)?", answer: "524" },
  { prompt: "How many positive divisors does 720 have?", answer: "30" },
  { prompt: "What is the smaller angle in degrees between the hour and minute hands of a clock at 3:40? Answer with the number only.", answer: "130" },
  { prompt: "What is the sum of the integers from 1 to 100 that are divisible by neither 3 nor 5?", answer: "2632" },
  { prompt: "Write the decimal number 2026 in base 7. Answer with the digits only.", answer: "5623" },
  { prompt: "When all integers from 1 to 1000 are written out in decimal, how many times does the digit 7 appear?", answer: "300" },
  { prompt: "What is the minimum number of moves a chess knight needs to go from square a1 to square h8?", answer: "6" },
  { prompt: "What does this JavaScript expression evaluate to? Give the resulting string without quotes: (\"b\" + \"a\" + +\"a\" + \"a\").toLowerCase()", answer: "banana" },
  { prompt: "How many trailing zeros does 125! (125 factorial) have?", answer: "31" },
  { prompt: "What does this JavaScript expression evaluate to? Give the resulting string without quotes: [10, 9, 1].sort().join(\",\")", answer: "1,10,9" },
];

/** A model that cannot finish the set in this time stays unrated today; a
 *  free tier can queue a turn for minutes before the model even starts. */
export const EVAL_TIMEOUT_MS = 5 * 60_000;

/** All tasks in one turn: one throwaway session per model, not one per task. */
export const evalPrompt = (tasks: readonly EvalTask[] = EVAL_TASKS): string => [
  "Do not use any tools. Solve every numbered problem by reasoning alone.",
  "Reply with exactly one line per problem in the form <number>: <answer>, in order, and nothing else.",
  "",
  ...tasks.map((task, index) => `${index + 1}. ${task.prompt}`),
].join("\n");

const normalizeAnswer = (value: string): string => value.trim().toLowerCase()
  .replace(/^[`"'*$\s]+|[`"'*.\s]+$/g, "")
  .replace(/\s+/g, "");

export interface EvalResult { correct: number; total: number; accuracy: number; measuredAt: number }

/** The last line for each problem number counts; a missing line is wrong. */
export const gradeEvalReply = (
  reply: string,
  tasks: readonly EvalTask[] = EVAL_TASKS,
  measuredAt = Date.now(),
): EvalResult => {
  const answers = new Map<number, string>();
  for (const line of reply.split("\n")) {
    const match = /^\s*\**\s*(\d{1,2})\s*\**\s*[:.)]\s*(.+?)\s*$/.exec(line);
    if (match) answers.set(Number(match[1]), match[2]!);
  }
  const correct = tasks.filter((task, index) => {
    const answer = answers.get(index + 1);
    return answer !== undefined && normalizeAnswer(answer) === normalizeAnswer(task.answer);
  }).length;
  if (answers.size === 0) throw Object.assign(new Error("free model evaluation reply has no numbered answers"), { code: "insufficient" });
  return { correct, total: tasks.length, accuracy: correct / tasks.length, measuredAt };
};

/**
 * Predict leaderboard ratings for models the leaderboard does not list from
 * their test accuracy, using the models that have both. An accuracy that
 * listed models also scored takes their mean rating: strong models saturate
 * the test, and equal results are the most direct evidence. Any other
 * accuracy needs a least-squares fit over at least three models with a
 * positive slope; otherwise nothing is predicted, because an uncalibrated
 * accuracy is not on the leaderboard's scale.
 */
export const calibrateRatings = (
  points: ReadonlyArray<{ rating: number; accuracy: number }>,
): ((accuracy: number) => number | undefined) | undefined => {
  if (points.length === 0) return undefined;
  const same = (accuracy: number): number | undefined => {
    const peers = points.filter((point) => point.accuracy === accuracy);
    return peers.length > 0 ? peers.reduce((sum, point) => sum + point.rating, 0) / peers.length : undefined;
  };
  const fit = linearFit(points);
  return (accuracy) => same(accuracy) ?? fit?.(accuracy);
};

const linearFit = (
  points: ReadonlyArray<{ rating: number; accuracy: number }>,
): ((accuracy: number) => number) | undefined => {
  if (points.length < 3) return undefined;
  const meanX = points.reduce((sum, point) => sum + point.accuracy, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.rating, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sxx += (point.accuracy - meanX) ** 2;
    sxy += (point.accuracy - meanX) * (point.rating - meanY);
  }
  if (sxx === 0 || sxy <= 0) return undefined;
  const slope = sxy / sxx;
  const low = Math.min(...points.map((point) => point.rating)) - 100;
  const high = Math.max(...points.map((point) => point.rating)) + 100;
  return (accuracy) => Math.max(low, Math.min(high, meanY + slope * (accuracy - meanX)));
};

// ------------------------------------------------------------------ store

export const SPEED_TTL_MS = 6 * 60 * 60_000;
export const QUALITY_TTL_MS = 24 * 60 * 60_000;
/** After a failed probe or download, wait this long before trying it again. */
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
/** A failed or timed-out test is expensive to repeat; try again much later. */
const EVAL_RETRY_AFTER_FAILURE_MS = 6 * 60 * 60_000;

type Model = Pick<ModelRef, "providerID" | "modelID">;

export interface FreeModelEvidence {
  speed(model: Model): SpeedSample | undefined;
  evaluation(model: Model): EvalResult | undefined;
  arena(): readonly ArenaEntry[] | undefined;
  /** Measure every model whose sample is missing or older than the TTL. */
  refreshSpeed(models: readonly Model[], measure: (model: Model) => Promise<SpeedSample>): Promise<void>;
  refreshArena(): Promise<void>;
  refreshEvaluations(models: readonly Model[], evaluate: (model: Model) => Promise<EvalResult>): Promise<void>;
}

const pool = async <T,>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
};

export const createFreeModelEvidence = (options: {
  http?: EvidenceHttp;
  now?: () => number;
  log?: (message: string, data?: Record<string, string>) => void;
} = {}): FreeModelEvidence => {
  const http = options.http ?? publicHttps;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message, data) => console.warn(`[polyth] ${message}`, JSON.stringify(data ?? {})));
  const speeds = new Map<string, SpeedSample>();
  const evaluations = new Map<string, EvalResult>();
  const failedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  let arenaRows: ArenaEntry[] | undefined;
  let arenaAt: number | undefined;

  const wanted = (key: string, measuredAt: number | undefined, ttl: number): boolean => {
    if (inFlight.has(key)) return true;
    const failed = failedAt.get(key);
    const backoff = key.startsWith("eval:") ? EVAL_RETRY_AFTER_FAILURE_MS : RETRY_AFTER_FAILURE_MS;
    if (failed !== undefined && now() - failed < backoff) return false;
    return measuredAt === undefined || now() - measuredAt >= ttl;
  };

  const once = (key: string, run: () => Promise<void>): Promise<void> => {
    const running = inFlight.get(key);
    if (running) return running;
    const promise = run()
      .then(() => { failedAt.delete(key); })
      .catch((error: unknown) => {
        // A runtime that went away cancelled the work; the model did not fail.
        if ((error as { code?: unknown })?.code === "cancelled") return;
        failedAt.set(key, now());
        log("free model evidence failed", { key, error: String((error as Error)?.message ?? error) });
      })
      .finally(() => { inFlight.delete(key); });
    inFlight.set(key, promise);
    return promise;
  };

  return {
    speed: (model) => speeds.get(modelKey(model)),
    evaluation: (model) => evaluations.get(modelKey(model)),
    arena: () => arenaRows,
    async refreshSpeed(models, measure) {
      const work = models.filter((model) => wanted(`speed:${modelKey(model)}`, speeds.get(modelKey(model))?.measuredAt, SPEED_TTL_MS));
      // Two at a time: concurrent probes would measure each other's queueing.
      await pool(work, 2, (model) => once(`speed:${modelKey(model)}`, async () => {
        speeds.set(modelKey(model), await measure(model));
      }));
    },
    async refreshArena() {
      if (!wanted("arena", arenaAt, QUALITY_TTL_MS)) return;
      await once("arena", async () => {
        const rows = await fetchArenaText(http);
        if (rows.length === 0) throw new Error("LMArena returned no overall rows");
        arenaRows = rows;
        arenaAt = now();
      });
    },
    async refreshEvaluations(models, evaluate) {
      const work = models.filter((model) => wanted(`eval:${modelKey(model)}`, evaluations.get(modelKey(model))?.measuredAt, QUALITY_TTL_MS));
      // Two at a time, so one slow model cannot hold every other result back.
      await pool(work, 2, (model) => once(`eval:${modelKey(model)}`, async () => {
        evaluations.set(modelKey(model), await evaluate(model));
      }));
    },
  };
};

let shared: FreeModelEvidence | undefined;
/** One store per server process: the evidence describes a free model, not a
 *  Space, so every OpenCode runtime reuses it instead of measuring again. */
export const sharedFreeModelEvidence = (): FreeModelEvidence => (shared ??= createFreeModelEvidence());
