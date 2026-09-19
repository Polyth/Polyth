import { StringDecoder } from "node:string_decoder";
import { isAbsolute } from "node:path";
import type { JsonObject, ModelDescriptor, ModelRef, RateLimitRetryHint, RuntimeCapabilities, RuntimeErrorCode, RuntimeEvent, TokenUsage } from "@polyth/contracts";

export const ANTIGRAVITY_CAPABILITIES = {
  streaming: true, permissions: true, questions: false, compaction: false,
  subagents: true, steering: false, resume: true, usage: true, cost: false,
  fork: false, mcp: true, title: "native", contextOccupancy: "unknown",
  attachments: { modalities: {
    file: "emulated", image: "unsupported", pdf: "unsupported",
    audio: "unsupported", url: "unsupported",
  } },
} as const satisfies RuntimeCapabilities;

export const agyError = (code: string, message: string) => Object.assign(new Error(message), { code });
export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

/** `agy models`: slug followed by a human label separated by two spaces or a tab. */
export function parseAgyModels(output: string): ModelDescriptor[] {
  const rows = new Map<string, ModelDescriptor>();
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const match = /^\s*([a-z0-9][a-z0-9._:/-]*)(?:\t+| {2,})(\S.*)\s*$/i.exec(line);
    if (!match?.[1] || !match[2] || /^(?:model|slug|id)$/i.test(match[1])) continue;
    rows.set(match[1], {
      harnessId: "antigravity", providerID: "antigravity", modelID: match[1],
      name: match[2].trim(), providerName: "Google Antigravity",
      capabilities: ["input:text", "output:text", "toolcall"],
      variants: ["low", "medium", "high"],
    });
  }
  return [...rows.values()];
}

export function agyLaunchArgs(
  model?: ModelRef,
  agent?: string,
  conversationId?: string,
  policy: { autoApprove?: boolean; hookRoot?: string } = {},
): string[] {
  const safe = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value);
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
  ];
  // Auto-Approve is deliberately the native all-tools bypass, not a weaker
  // adapter-side approximation. Review mode omits it and routes tool decisions
  // through Polyth's PreToolUse bridge. The optional CLI sandbox is never used.
  if (policy.autoApprove) args.push("--dangerously-skip-permissions");
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
      if (!["low", "medium", "high"].includes(model.variant)) throw agyError("invalid-variant", "Antigravity effort must be low, medium or high");
      args.push("--effort", model.variant);
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

export const sameAgyModel = (a?: ModelRef, b?: ModelRef) =>
  a?.providerID === b?.providerID && a?.modelID === b?.modelID && a?.variant === b?.variant;

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

/** Only public agent_response content is dialogue. Tool output and thinking stay separate. */
export function createAgyTurn(turnId: string, model: ModelRef | undefined) {
  const messages = new Map<number, string>();
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
  const agents = new Map<string, { sessionId: string; label: string; status: string; currentTask?: string }>();
  let revision = 0;
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
          if (failed || failure !== undefined || info?.error) {
            const error = failure ?? "Antigravity tool failed";
            noteToolFailure(error);
            events.push({ type: "tool/error", callId: id, tool, error });
          } else {
            successfulTools++;
            events.push({ type: "tool/result", callId: id, tool, output: settledOutput, ...(Object.keys(settledInput).length > 0 ? { input: settledInput } : {}) });
          }
        }
      }
      const subagents = record(row.subagent_info)?.subagents;
      if (Array.isArray(subagents)) {
        for (const value of subagents) {
          const sub = record(value);
          const sessionId = text(sub?.conversation_id);
          if (!sessionId) continue;
          // A completed spawn step is NOT proof that the child agent finished.
          // No log_uri/workspace paths are copied into canonical activity.
          agents.set(sessionId, { sessionId, label: text(sub?.type_name) ?? "Antigravity agent", status: "unknown", ...(text(sub?.role) ? { currentTask: text(sub?.role) } : {}) });
        }
        events.push({ type: "subagent/snapshot", revision: ++revision, agents: [...agents.values()] });
      }
      // The CLI may surface one logical `invoke_subagent` call as a `tool` step
      // (the proposal, which opened a tool call) followed by a `subagent` step
      // (the spawn acknowledgement). Settling the subagent step must close the
      // still-open call as a result; otherwise it is misreported as an
      // unterminated tool at turn end and the delegated agent looks stopped.
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
      // Headless Antigravity soft-denies permission prompts, but still reports
      // SUCCESS and exit 0. A SUCCESS result with no public response therefore
      // cannot prove a completed assistant turn when every attempted tool was
      // definitively denied before execution. Surface that proven non-
      // application instead of leaving Polyth idle with no answer. If any tool
      // succeeded (or failed ambiguously), preserve SUCCESS: offering a retry
      // could duplicate a mutation whose outcome is already confirmed/unknown.
      const hasAssistantResponse = [...messages.values()].some((body) => body.trim().length > 0)
        || (text(result.response)?.trim().length ?? 0) > 0;
      const silentPermissionDenial = status === "SUCCESS" && !hasAssistantResponse
        && failedTools > 0 && deniedTools === failedTools && successfulTools === 0;
      const failure = status === "ERROR" || status === "INVALID"
        ? classifyAgyTurnFailure(result, now)
        : undefined;
      events.push({ type: "turn/stopped", turnId,
        reason: status === "SUCCESS" && !silentPermissionDenial ? "completed" : status === "CANCELED" || status === "INTERRUPTED" ? "aborted" : "error",
        ...(silentPermissionDenial ? { error: "Antigravity denied a tool instead of completing Polyth's approval flow. No mutation was confirmed; check the permission bridge and native policy, then retry.", code: "unknown" as const }
          : failure ? failure : {}),
      });
      return events;
    },
  };
}
