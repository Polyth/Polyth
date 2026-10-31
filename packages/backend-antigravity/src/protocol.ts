import { StringDecoder } from "node:string_decoder";
import { isAbsolute } from "node:path";
import type { JsonObject, ModelDescriptor, ModelRef, RateLimitRetryHint, RuntimeCapabilities, RuntimeErrorCode, RuntimeEvent, TokenUsage } from "@polyth/contracts";
import { contextWindowTelemetry } from "@polyth/harness-runtime";
import { AGY_QUESTION_ANSWERED, AGY_QUESTION_DISMISSED } from "./questions.ts";

/**
 * What the headless stream-json adapter actually delivers (CLI 1.2.9):
 * - Questions and steering use the runtime-private hooks: `ask_question` is
 *   answered through Polyth, and a steer is injected as a native user message
 *   before the next model invocation (a `Stop` hook re-enters the loop when
 *   the model was already finishing).
 * - Binary attachments are emulated: stream-json input is text-only, so a
 *   staged copy is opened by the CLI's own `view_file` (or `read_url_content`
 *   for a link) before the turn's first model call.
 * - Context occupancy is derived from the last model call's input tokens; the
 *   CLI reports no context-window size, compaction trigger, fork or cost in
 *   headless mode, so those stay unsupported instead of being approximated.
 *   Its automatic compaction (a `checkpoint` step) is recorded when it happens.
 * - Native skills are discovered from the CLI's `/skills` report and invoked
 *   as a leading slash command.
 * - The shipped package launches with the native permission bypass so the
 *   headless CLI does not auto-deny. Its PreToolUse hook denies delegation and
 *   beta mutations, allows workspace reads/edits and attachment opens, and
 *   sends every other tool to Polyth as a canonical permission request.
 */
export const ANTIGRAVITY_CAPABILITIES = {
  streaming: true, permissions: true, questions: true, compaction: false,
  subagents: false, steering: true, resume: true, usage: true, cost: false,
  fork: false, mcp: true, title: "native", contextOccupancy: "derived",
  attachments: { modalities: {
    file: "emulated", image: "emulated", pdf: "emulated",
    audio: "emulated", url: "emulated",
  } },
  commands: { discovery: "native", invoke: "raw-native-input" },
} as const satisfies RuntimeCapabilities;

/** `agy models` reports no modality metadata. The CLI's own `view_file` stays
 * the final authority (it refuses a binary type the selected model cannot
 * read); this conservative family table only decides which attachments Polyth
 * offers. An unrecognized model family is text-only. */
export const agyModelInputs = (modelID: string): string[] =>
  /^gemini-/i.test(modelID) ? ["input:image", "input:pdf", "input:audio"]
    : /^claude-/i.test(modelID) ? ["input:image", "input:pdf"]
      : [];

export const agyError = (code: string, message: string) => Object.assign(new Error(message), { code });
export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Bounds one stored compaction summary; the native one is a few KB. */
const COMPACTION_SUMMARY_MAX_CHARS = 64_000;

export const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Strict frame bounds, including a split UTF-8 character and a final line without LF. */
export function createAgyDecoder(onFrame: (frame: Record<string, unknown>) => void, maxBytes = 4 * 1024 * 1024) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const parse = (line: string) => {
    if (Buffer.byteLength(line, "utf8") > maxBytes) throw agyError("protocol-error", "Antigravity frame exceeds the size limit");
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw agyError("protocol-error", "Antigravity returned malformed JSON"); }
    const frame = record(value);
    if (!frame || typeof frame.event !== "string") throw agyError("protocol-error", "Antigravity returned an invalid event envelope");
    onFrame(frame);
  };
  const consume = (data: string) => {
    pending += data;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      parse(line);
    }
    if (Buffer.byteLength(pending, "utf8") > maxBytes) throw agyError("protocol-error", "Antigravity frame exceeds the size limit");
  };
  return {
    write(chunk: Buffer | string) { consume(typeof chunk === "string" ? chunk : decoder.write(chunk)); },
    end() { consume(decoder.end()); if (pending) { const last = pending; pending = ""; parse(last); } },
  };
}

const AGY_EFFORTS = ["low", "medium", "high"];

export const agyModelEffort = (modelID: string): string | undefined =>
  /-(low|medium|high)$/i.exec(modelID)?.[1]?.toLowerCase();

export const agyBaseModel = (modelID: string): string => {
  const effort = agyModelEffort(modelID);
  return effort ? modelID.slice(0, -(effort.length + 1)) : modelID;
};

export const agyBaseName = (name: string): string =>
  name.replace(/\s*\((?:low|medium|high)\)$/i, "").trim();

/** `agy models`: slug followed by a human label separated by two spaces or a tab.
 * The CLI lists every effort as its own ID (`gemini-3.8-flash-high`); rows that
 * differ only by that suffix become one model (`gemini-3.8-flash`) whose
 * `variants` are exactly the listed efforts (default `high` when listed). CLI
 * 1.3.1 resolves `--model <base> --effort <variant>` to the suffixed ID and
 * refuses an effort the model does not list.
 * `harnessId` scopes the catalog to the default harness or one account. */
export function parseAgyModels(output: string, harnessId = "antigravity"): ModelDescriptor[] {
  const rows = new Map<string, ModelDescriptor>();
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = /^\s*([a-z0-9][a-z0-9._:/-]*)(?:\t+| {2,})(\S.*)\s*$/i.exec(line);
    if (!match?.[1] || !match[2] || /^(?:model|slug|id)$/i.test(match[1])) continue;
    const rawSlug = match[1];
    const rawName = match[2].trim();
    const effort = agyModelEffort(rawSlug);
    const baseSlug = effort ? agyBaseModel(rawSlug) : rawSlug;
    const baseName = effort ? agyBaseName(rawName) : rawName;

    const existing = rows.get(baseSlug);
    if (!existing) {
      rows.set(baseSlug, {
        harnessId, providerID: "antigravity", modelID: baseSlug,
        name: baseName, providerName: "Google Antigravity",
        capabilities: ["input:text", ...agyModelInputs(baseSlug), "output:text", "toolcall"],
        ...(effort ? { variants: [effort], defaultVariant: effort } : {}),
      });
    } else {
      if (effort) {
        const variants = existing.variants ? [...existing.variants] : [];
        if (!variants.includes(effort)) {
          variants.push(effort);
          variants.sort((a, b) => AGY_EFFORTS.indexOf(a) - AGY_EFFORTS.indexOf(b));
          existing.variants = variants;
        }
        if (!existing.defaultVariant || effort === "high") {
          existing.defaultVariant = effort === "high" ? "high" : (existing.defaultVariant ?? effort);
        }
      } else {
        existing.name = baseName;
      }
    }
  }
  return [...rows.values()];
}

export function agyLaunchArgs(
  model?: ModelRef,
  agent?: string,
  conversationId?: string,
  policy: { bypass?: boolean; hookRoot?: string } = {},
): string[] {
  const safe = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value);
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
  ];
  // In print/stream-json mode the CLI auto-denies every tool that needs an
  // approval interaction and never turns a PreToolUse `allow` decision into a
  // grant (verified against CLI 1.2.7), so without this flag no gated tool can
  // run at all. The flag only removes the CLI's own prompt: the bridge stays
  // installed and is still consulted under it, so every gated tool is decided
  // by Polyth (rules, Auto-Approve and its high-risk hold, or a person) and a
  // hook deny or fail-closed error still blocks it. The optional CLI sandbox
  // is never used.
  if (policy.bypass) args.push("--dangerously-skip-permissions");
  if (policy.hookRoot) {
    if (!isAbsolute(policy.hookRoot) || policy.hookRoot.includes("\0"))
      throw agyError("invalid-path", "Antigravity permission bridge root must be absolute");
    args.push("--add-dir", policy.hookRoot);
  }
  if (conversationId) {
    if (!safe(conversationId)) throw agyError("invalid-session", "Invalid Antigravity conversation ID");
    args.push("--conversation", conversationId);
  }
  if (model) {
    if (model.providerID !== "antigravity" || !safe(model.modelID))
      throw agyError("invalid-model", "Select a model from the Antigravity catalog");
    args.push("--model", model.modelID);
    if (model.variant) {
      if (!AGY_EFFORTS.includes(model.variant)) throw agyError("invalid-variant", "Antigravity effort must be low, medium or high");
      // An ID that names its effort already selects it; the CLI refuses a
      // different `--effort` at launch, so reject that before it starts.
      const fixed = agyModelEffort(model.modelID);
      if (fixed && fixed !== model.variant)
        throw agyError("invalid-variant", `${model.modelID} runs at ${fixed} effort; pick the ${model.variant} entry from the Antigravity catalog`);
      if (!fixed) args.push("--effort", model.variant);
    }
  }
  if (agent) {
    if (!safe(agent)) throw agyError("invalid-agent", "Invalid Antigravity agent name");
    args.push("--agent", agent);
  }
  // Never add ambient --continue, -p, shell interpolation, or --sandbox.
  return args;
}

export function agyUsage(value: unknown): TokenUsage | undefined {
  const row = record(value);
  if (!row || count(row.input_tokens) === undefined || count(row.output_tokens) === undefined) return undefined;
  const optional = { reasoning: count(row.thinking_tokens), cacheRead: count(row.cache_read_tokens) };
  return {
    input: row.input_tokens as number, output: row.output_tokens as number,
    ...(optional.reasoning !== undefined ? { reasoning: optional.reasoning } : {}),
    ...(optional.cacheRead !== undefined ? { cacheRead: optional.cacheRead } : {}),
  };
}

/** The effort a selection runs at: the explicit one, else the one its ID names.
 * Choosing an ID's own effort launches exactly the same native command. */
const agyEffort = (model?: ModelRef): string | undefined =>
  model?.variant || (model ? agyModelEffort(model.modelID) : undefined);

export const sameAgyModel = (a?: ModelRef, b?: ModelRef) =>
  a?.providerID === b?.providerID
  && (a?.modelID === b?.modelID || (Boolean(a?.modelID && b?.modelID) && agyBaseModel(a!.modelID) === agyBaseModel(b!.modelID)))
  && agyEffort(a) === agyEffort(b);

/** Native states that end a step without a DONE result. Every other state is
 * in-flight or unrecognized: a step frame must never abort the runtime, so an
 * unknown state degrades to observation instead of a protocol error. */
const AGY_FAILED_STATES = new Set(["ERROR", "INVALID", "HALTED", "CANCELED", "INTERRUPTED"]);

/** Native failure text, from the tool payload or the step itself. */
function agyFailureText(row: Record<string, unknown>, info?: Record<string, unknown>): string | undefined {
  for (const candidate of [info?.error, row.error]) {
    const direct = text(candidate);
    if (direct) return direct;
    const nested = record(candidate);
    if (!nested) continue;
    for (const key of ["message", "details", "type"]) {
      const value = text(nested[key]);
      if (value) return value;
    }
  }
  return undefined;
}

type AgyTurnFailure = {
  error: string;
  code: RuntimeErrorCode;
  retry?: RateLimitRetryHint;
};

const AGY_QUOTA_ERROR = /\b(?:individual\s+quota|quota\s+(?:reached|exhausted|depleted)|out\s+of\s+(?:credits?|quota)|credit\s+balance|usage\s+limit)\b/i;
const AGY_RATE_ERROR = /\b(?:rate[_\s-]?limit|too\s+many\s+requests|throttl(?:e|ed|ing)|429)\b/i;
const AGY_OVERLOAD_ERROR = /\b(?:overload(?:ed)?|at\s+capacity|server\s+is\s+busy|temporarily\s+unavailable|503|529)\b/i;
const AGY_RESOURCE_EXHAUSTED = /\bresource[_\s-]?exhausted\b/i;

const positiveNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** Parse the duration forms Antigravity uses in quota failures, for example
 * `Resets in 2h 30m` or a structured `retry_delay: "45s"`. */
function agyDurationSeconds(value: unknown): number | undefined {
  if (typeof value === "number") return positiveNumber(value);
  if (typeof value !== "string") return undefined;
  const plain = Number(value.trim());
  if (Number.isFinite(plain) && plain > 0) return plain;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hr|hours?|d|days?)/gi)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (unit === "ms") total += amount / 1_000;
    else if (unit.startsWith("s")) total += amount;
    else if (unit.startsWith("m")) total += amount * 60;
    else if (unit.startsWith("h")) total += amount * 3_600;
    else total += amount * 86_400;
  }
  return matched && total > 0 ? Math.ceil(total) : undefined;
}

function agyResetAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value > 1e12 ? value : value * 1_000;
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function classifyAgyTurnFailure(result: Record<string, unknown>, now: number): AgyTurnFailure {
  const nested = record(result.error);
  const diagnostic = record(result.agy_error);
  const resultError = text(result.error) ?? text(nested?.message);
  const diagnosticMessage = text(diagnostic?.message) ?? text(diagnostic?.details);
  const error = diagnosticMessage && (!resultError || /^(?:agent execution terminated|antigravity did not complete)/i.test(resultError))
    ? diagnosticMessage
    : resultError ?? diagnosticMessage
    ?? "Antigravity did not complete the turn. Check the native CLI authentication, model access and permission settings.";
  const structured = diagnostic ?? nested ?? result;
  const classificationText = [
    error,
    text(diagnostic?.status),
    text(diagnostic?.code),
    text(diagnostic?.grpc_code),
    positiveNumber(diagnostic?.http_status)?.toString(),
  ].filter(Boolean).join(" ");
  const auth = /\b(?:authentication|required|unauthenticated|unauthorized|invalid_grant|expired\s+(?:token|credential)|sign[ -]?in)\b/i.test(classificationText);
  const modelUnavailable = /\b(?:unknown|unsupported|unavailable|invalid|unrecognized|restricted)\s+model\b|\bmodel\b[^.\n]{0,60}\bnot\s+(?:available|enabled|included|supported|permitted|authorized|accessible)\b/i.test(classificationText);
  if (auth) return { error, code: "auth-expired" };
  if (modelUnavailable) return { error, code: "model-unavailable" };

  const scope = AGY_QUOTA_ERROR.test(classificationText) ? "quota"
    : AGY_OVERLOAD_ERROR.test(classificationText) ? "overloaded"
      : AGY_RATE_ERROR.test(classificationText) ? "rate"
        : AGY_RESOURCE_EXHAUSTED.test(classificationText) ? "quota"
        : undefined;
  if (!scope) return { error, code: "unknown" };

  let retryAfterSec: number | undefined;
  for (const key of ["retryAfter", "retryAfterSec", "retry_after", "retry_delay", "retryDelay"]) {
    retryAfterSec = agyDurationSeconds(structured[key]);
    if (retryAfterSec !== undefined) break;
  }
  if (retryAfterSec === undefined) {
    const duration = error.match(/(?:resets?|available\s+again|try\s+again|retry(?:\s+again)?)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hr|hours?|d|days?)\s*)+)/i)?.[1];
    retryAfterSec = agyDurationSeconds(duration);
  }

  let resetAt: number | undefined;
  for (const key of ["resetAt", "reset_at", "resetsAt", "resets_at", "resetTime", "reset_time"]) {
    resetAt = agyResetAt(structured[key]);
    if (resetAt !== undefined) break;
  }
  if (resetAt === undefined) {
    const timestamp = error.match(/resets?\s+(?:at|on)\s+([^.,;\n]+(?:Z|[+-]\d\d:?\d\d)?)/i)?.[1];
    resetAt = agyResetAt(timestamp);
  }
  if (resetAt === undefined && retryAfterSec !== undefined) resetAt = now + retryAfterSec * 1_000;
  const explicitRetryable = typeof structured.retryable === "boolean" ? structured.retryable : undefined;
  const retry: RateLimitRetryHint = {
    scope,
    provider: "google",
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    // A concrete future reset is stronger product-level retry evidence than
    // AGY's per-request retryable bit: the latter can be false after the CLI
    // exhausts its immediate retries even though the quota window will reopen.
    retryable: resetAt !== undefined || retryAfterSec !== undefined ? true : explicitRetryable ?? true,
  };
  return {
    error,
    code: scope === "quota" ? "quota-exhausted" : scope === "overloaded" ? "overloaded" : "rate-limited",
    retry,
  };
}

/** A native `ask_question` call Polyth answered settles as a hook denial whose
 * reason carries the user's answer; present it as that answer, not a failure. */
const polythQuestionReply = (failure: string | undefined): string | undefined => {
  if (!failure) return undefined;
  const at = [AGY_QUESTION_ANSWERED, AGY_QUESTION_DISMISSED]
    .map((marker) => failure.indexOf(marker))
    .filter((index) => index >= 0);
  return at.length ? failure.slice(Math.min(...at)) : undefined;
};

/** Only public agent_response content is dialogue. Tool output and thinking stay separate. */
export function createAgyTurn(turnId: string, model: ModelRef | undefined) {
  const messages = new Map<number, string>();
  const reasoning = new Map<number, string>();
  const finished = new Set<number>();
  const startedTools = new Set<number>();
  const openTools = new Map<number, string>();
  // A native tool step can stream its arguments over several frames: the first
  // frame may carry only the target path. Accumulate every frame and attach the
  // complete object to the terminal tool event so canonical consumers (diffs,
  // changed-file tracking) see the same input the native CLI executed.
  const toolInputs = new Map<number, JsonObject>();
  // Native result text can arrive on a companion `generic` step separate from
  // the `tool` step; cache it by step index so a settle can pick it up.
  const stepContents = new Map<number, string>();
  // Full planner tool-call arguments, in request order. The tool execution step
  // sometimes only projects the target argument, so keep the proposal args and
  // merge them into the matching call.
  const plannerCalls: Array<{ tool: string; args: JsonObject }> = [];
  const stepUsage = new Map<number, TokenUsage>();
  let terminal = false;
  let deltaCount = 0;
  let responseBytes = 0;
  let failedTools = 0;
  let deniedTools = 0;
  let successfulTools = 0;
  const noteToolFailure = (error: string) => {
    failedTools++;
    if (/\b(?:permission|denied|approval|not allowed|unsandboxed)\b/i.test(error)) deniedTools++;
  };
  return {
    get terminal() { return terminal; },
    get deltaCount() { return deltaCount; },
    step(row: Record<string, unknown>): RuntimeEvent[] {
      if (terminal) return [];
      const index = count(row.step_index);
      if (index === undefined) throw agyError("protocol-error", "Antigravity step has no valid index");
      if (finished.has(index)) return [];
      if (finished.size + messages.size + startedTools.size > 32768) throw agyError("protocol-error", "Antigravity turn exceeds the step limit");
      const state = text(row.state);
      const done = state === "DONE";
      const failed = state !== undefined && AGY_FAILED_STATES.has(state);
      const settled = done || failed;
      const checkpoint = typeof row.step_type === "string" && /^checkpoint$/i.test(row.step_type);
      const events: RuntimeEvent[] = [];
      const usage = settled ? agyUsage(row.usage) : undefined;
      if (usage) stepUsage.set(index, usage);
      const id = `${turnId}:step:${index}`;
      const content = text(row.content);
      if (content) {
        stepContents.set(index, content);
        if (stepContents.size > 256) stepContents.delete(stepContents.keys().next().value!);
      }
      if (Array.isArray(row.tool_calls)) {
        for (const value of row.tool_calls) {
          const call = record(value);
          const name = text(call?.name) ?? text(call?.tool) ?? text(call?.tool_name);
          const args = record(call?.args) ?? record(call?.arguments) ?? record(call?.parameters);
          if (!name || !args || Object.keys(args).length === 0) continue;
          plannerCalls.push({ tool: name, args: args as JsonObject });
          if (plannerCalls.length > 256) plannerCalls.shift();
        }
      }
      if (row.step_type === "agent_response") {
        const delta = text(row.text_delta);
        if (delta) {
          responseBytes += Buffer.byteLength(delta);
          if (responseBytes > 32 * 1024 * 1024) throw agyError("protocol-error", "Antigravity response exceeds the size limit");
          messages.set(index, (messages.get(index) ?? "") + delta);
          events.push({ type: "assistant/chunk", partId: id, text: delta });
          deltaCount++;
        }
        if (settled && messages.has(index)) events.push({ type: "assistant/message", partId: id, text: messages.get(index)! });
      } else if (row.step_type === "thinking") {
        const delta = text(row.text_delta);
        if (delta) {
          const reasoningText = (reasoning.get(index) ?? "") + delta;
          reasoning.set(index, reasoningText);
          events.push({ type: "assistant/reasoning-chunk", partId: id, text: delta });
        }
        if (settled) {
          const reasoningText = reasoning.get(index) ?? content ?? stepContents.get(index);
          if (reasoningText) events.push({ type: "assistant/message", partId: id, text: "", reasoning: reasoningText });
          reasoning.delete(index);
          stepContents.delete(index);
        }
      } else if (row.step_type === "tool") {
        const info = record(row.tool_info);
        const tool = text(info?.name) ?? text(row.tool_name) ?? "unknown";
        const stepInput = (record(info?.parameters) ?? {}) as JsonObject;
        const input: JsonObject = { ...(toolInputs.get(index) ?? {}) };
        if (!startedTools.has(index)) {
          startedTools.add(index);
          const pendingIndex = plannerCalls.findIndex((call) => call.tool === tool);
          const proposed = pendingIndex >= 0 ? plannerCalls.splice(pendingIndex, 1)[0]!.args : {};
          Object.assign(input, proposed, stepInput);
          toolInputs.set(index, input);
          openTools.set(index, tool);
          events.push({ type: "tool/started", callId: id, tool, input });
        } else {
          Object.assign(input, stepInput);
          toolInputs.set(index, input);
        }
        if (settled) {
          const failure = agyFailureText(row, info);
          const settledInput = toolInputs.get(index) ?? input;
          // The native result text may arrive on this `tool` step or on a
          // companion `generic` step cached above; `tool_info.output` is not
          // always populated for file edits.
          const settledOutput = text(info?.output) ?? text(row.content) ?? stepContents.get(index) ?? "";
          toolInputs.delete(index);
          stepContents.delete(index);
          openTools.delete(index);
          const answered = tool === "ask_question" ? polythQuestionReply(failure) : undefined;
          if (answered !== undefined) {
            successfulTools++;
            events.push({ type: "tool/result", callId: id, tool, output: answered, ...(Object.keys(settledInput).length > 0 ? { input: settledInput } : {}) });
          } else if (failed || failure !== undefined || info?.error) {
            const error = failure ?? "Antigravity tool failed";
            noteToolFailure(error);
            events.push({ type: "tool/error", callId: id, tool, error });
          } else {
            successfulTools++;
            events.push({ type: "tool/result", callId: id, tool, output: settledOutput, ...(Object.keys(settledInput).length > 0 ? { input: settledInput } : {}) });
          }
        }
      } else if (checkpoint && done) {
        // A native checkpoint is the CLI's own context compaction (a system
        // summary replacing the earlier conversation). Occupancy is unknown
        // until the next model call reports its prompt size.
        // Its settled content is the CLI's summary; streamed text deltas are
        // the internal compaction prompt and stay out of history.
        const summary = (content ?? stepContents.get(index))?.trim().slice(0, COMPACTION_SUMMARY_MAX_CHARS);
        events.push(
          { type: "session/compacted", backendEventId: id, ...(summary ? { summary } : {}) },
          { type: "context/updated", ...contextWindowTelemetry({ source: "unknown", compaction: { active: false, lastAt: Date.now() } }) },
        );
      }
      // Native subagent/spawn metadata is provider-internal. Delegated workers
      // are canonical Polyth child sessions created through agent.spawn, so a
      // stale or external native frame must never synthesize a shadow identity.
      // A stale/external native runtime can still surface one logical
      // `invoke_subagent` call as a tool proposal followed by a subagent/spawn
      // acknowledgement. That acknowledgement may settle the ordinary tool
      // lifecycle, but it never creates a Polyth subagent identity.
      if (settled && openTools.has(index)) {
        const tool = openTools.get(index)!;
        const input = toolInputs.get(index) ?? {};
        const content = text(row.content) ?? stepContents.get(index) ?? "";
        openTools.delete(index);
        toolInputs.delete(index);
        stepContents.delete(index);
        const info = record(row.tool_info);
        const failure = agyFailureText(row, info);
        if (failed || failure !== undefined || info?.error) {
          const error = failure ?? "Antigravity subagent failed";
          noteToolFailure(error);
          events.push({ type: "tool/error", callId: id, tool, error });
        } else {
          successfulTools++;
          events.push({ type: "tool/result", callId: id, tool, output: text(info?.output) ?? content, ...(Object.keys(input).length > 0 ? { input } : {}) });
        }
      }
      // A model call's footprint is the whole prompt: the non-cached input plus
      // the cached prefix it read back. `input_tokens` excludes the cache
      // counters (its turn total cannot otherwise be smaller than the cached
      // reads it sums to), so publishing `input` alone would understate a
      // cached call. The CLI reports no window size. A checkpoint's own call
      // read the pre-compaction conversation.
      if (usage && usage.input > 0 && !checkpoint)
        events.push({ type: "context/updated", ...contextWindowTelemetry({ source: "derived", usedTokens: usage.input + (usage.cacheRead ?? 0) }) });
      if (settled) finished.add(index);
      return events;
    },
    finish(result: Record<string, unknown>, usage?: TokenUsage, now = Date.now()): RuntimeEvent[] {
      if (terminal) return [];
      const status = text(result.status);
      if (!["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID"].includes(status ?? ""))
        throw agyError("protocol-error", "Antigravity result is not terminal");
      terminal = true;
      const events: RuntimeEvent[] = [];
      // A tool the native CLI never terminated must not stay "running" forever.
      for (const [index, tool] of openTools) {
        const error = "Antigravity ended the turn without reporting a result for this tool call";
        noteToolFailure(error);
        events.push({ type: "tool/error", callId: `${turnId}:step:${index}`, tool, error });
      }
      openTools.clear();
      toolInputs.clear();
      reasoning.clear();
      stepContents.clear();
      if (!messages.size && text(result.response)) events.push({ type: "assistant/message", partId: `${turnId}:result`, text: text(result.response)! });
      else for (const [index, body] of messages) if (!finished.has(index))
        events.push({ type: "assistant/message", partId: `${turnId}:step:${index}`, text: body });
      // Result counters are authoritative when their baseline is known. For a
      // resumed process with unknown baseline use only observed final steps.
      if (!usage && stepUsage.size) {
        usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
        for (const part of stepUsage.values()) {
          usage.input += part.input; usage.output += part.output;
          usage.reasoning! += part.reasoning ?? 0; usage.cacheRead! += part.cacheRead ?? 0;
        }
      }
      if (usage) events.push({ type: "usage/recorded", model: model ?? { providerID: "antigravity", modelID: "unknown" }, tokens: usage });
      // Headless Antigravity auto-denies every tool that needs an approval
      // interaction it cannot prompt for, but still reports SUCCESS and exit 0.
      // A SUCCESS result with no public response therefore cannot prove a
      // completed assistant turn when every attempted tool was definitively
      // denied before execution. Surface that proven non-application with the
      // action that actually unblocks it instead of leaving Polyth idle. If any
      // tool succeeded (or failed ambiguously), preserve SUCCESS: offering a
      // retry could duplicate a mutation whose outcome is already confirmed.
      const hasAssistantResponse = [...messages.values()].some((body) => body.trim().length > 0)
        || (text(result.response)?.trim().length ?? 0) > 0;
      const silentPermissionDenial = status === "SUCCESS" && !hasAssistantResponse
        && failedTools > 0 && deniedTools === failedTools && successfulTools === 0;
      const failure = status === "ERROR" || status === "INVALID"
        ? classifyAgyTurnFailure(result, now)
        : undefined;
      events.push({ type: "turn/stopped", turnId,
        reason: status === "SUCCESS" && !silentPermissionDenial ? "completed" : status === "CANCELED" || status === "INTERRUPTED" ? "aborted" : "error",
        ...(silentPermissionDenial ? { error: "Antigravity auto-denied a tool because its headless mode cannot prompt for approval and Polyth's bridge cannot grant one. No mutation was confirmed; check the CLI's own permission rules, then retry.", code: "unknown" as const }
          : failure ? failure : {}),
      });
      return events;
    },
  };
}
