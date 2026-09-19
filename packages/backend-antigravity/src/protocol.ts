import { StringDecoder } from "node:string_decoder";
import type { ModelDescriptor, ModelRef, RuntimeCapabilities, RuntimeEvent, TokenUsage } from "@polyth/contracts";

export const ANTIGRAVITY_CAPABILITIES = {
  streaming: true, permissions: false, questions: false, compaction: false,
  subagents: true, steering: false, resume: true, usage: true, cost: false,
  fork: false, mcp: false, title: "emulated", contextOccupancy: "unknown",
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

export function agyLaunchArgs(model?: ModelRef, agent?: string, conversationId?: string): string[] {
  const safe = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value);
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
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
  // Never add ambient --continue, -p, shell interpolation, or permission bypass.
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

/** Only public agent_response content is dialogue. Tool output and thinking stay separate. */
export function createAgyTurn(turnId: string, model: ModelRef | undefined) {
  const messages = new Map<number, string>();
  const finished = new Set<number>();
  const startedTools = new Set<number>();
  const openTools = new Map<number, string>();
  const stepUsage = new Map<number, TokenUsage>();
  const agents = new Map<string, { sessionId: string; label: string; status: string; currentTask?: string }>();
  let revision = 0;
  let terminal = false;
  let deltaCount = 0;
  let responseBytes = 0;
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
        const input = record(info?.parameters) ?? {};
        if (!startedTools.has(index)) {
          startedTools.add(index);
          openTools.set(index, tool);
          events.push({ type: "tool/started", callId: id, tool, input: input as import("@polyth/contracts").JsonObject });
        }
        if (settled) {
          const failure = agyFailureText(row, info);
          openTools.delete(index);
          if (failed || failure !== undefined || info?.error) events.push({ type: "tool/error", callId: id, tool, error: failure ?? "Antigravity tool failed" });
          else events.push({ type: "tool/result", callId: id, tool, output: text(info?.output) ?? "" });
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
      if (settled) finished.add(index);
      return events;
    },
    finish(result: Record<string, unknown>, usage?: TokenUsage): RuntimeEvent[] {
      if (terminal) return [];
      const status = text(result.status);
      if (!["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID"].includes(status ?? ""))
        throw agyError("protocol-error", "Antigravity result is not terminal");
      terminal = true;
      const events: RuntimeEvent[] = [];
      // A tool the native CLI never terminated must not stay "running" forever.
      for (const [index, tool] of openTools)
        events.push({ type: "tool/error", callId: `${turnId}:step:${index}`, tool, error: "Antigravity ended the turn without reporting a result for this tool call" });
      openTools.clear();
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
      events.push({ type: "turn/stopped", turnId,
        reason: status === "SUCCESS" ? "completed" : status === "CANCELED" || status === "INTERRUPTED" ? "aborted" : "error",
        ...(status === "ERROR" || status === "INVALID" ? { error: "Antigravity did not complete the turn. Check the native CLI authentication, model access and permission settings.", code: "unknown" as const } : {}),
      });
      return events;
    },
  };
}
