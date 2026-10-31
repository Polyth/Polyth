// Wake scripts: a few lines of JavaScript that decide what an event wake does.
// They run in QuickJS compiled to WebAssembly: the interpreter has no file
// system, network, process or host objects at all — only what is passed in.
// Memory, stack and time are bounded per run; any failure skips the wake.
// Server-only (loads WebAssembly).
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import { SCRIPT_MAX_CHARS, type AgentEvent } from "./agentEvents.ts";
const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const STACK_LIMIT_BYTES = 256 * 1024;
const TIME_LIMIT_MS = 50;
const NOTE_LIMIT = 2_000;

export type ScriptDecision =
  | { action: "run"; note?: string }
  | { action: "skip"; reason?: string }
  | { action: "pause"; reason?: string };

export type ScriptResult =
  | { ok: true; decision: ScriptDecision; ms: number }
  | { ok: false; error: string; ms: number };

/** What a script sees: data only, as plain JSON. */
export interface ScriptInput {
  events: Array<Pick<AgentEvent, "kind" | "at" | "outcome" | "fields"> & { source?: string }>;
  agent: { name: string; runsToday: number; lastRunAt: number | null };
}

let module: Promise<QuickJSWASMModule> | null = null;
// The package's CommonJS typings describe the module object; under ESM the
// default import is the variant itself.
const variant = releaseSync as unknown as Parameters<typeof newQuickJSWASMModuleFromVariant>[0];
const quickjs = (): Promise<QuickJSWASMModule> => (module ??= newQuickJSWASMModuleFromVariant(variant));

const fail = (error: string, started: number): ScriptResult => ({ ok: false, error, ms: Date.now() - started });

/** Interpret a script's return value; anything else is an error. */
function decisionOf(value: unknown): ScriptDecision | string {
  if (value === undefined || value === true) return { action: "run" };
  if (value === false || value === null) return { action: "skip" };
  if (!value || typeof value !== "object") return "the script must return { action: \"run\" | \"skip\" | \"pause\" }";
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" ? (record[key] as string).slice(0, NOTE_LIMIT) : undefined;
  if (record.action === "run") return { action: "run", ...(text("note") ? { note: text("note")! } : {}) };
  if (record.action === "skip") return { action: "skip", ...(text("reason") ? { reason: text("reason")! } : {}) };
  if (record.action === "pause") return { action: "pause", ...(text("reason") ? { reason: text("reason")! } : {}) };
  return `unknown action ${JSON.stringify(record.action)}; use run, skip or pause`;
}

/** Run `source` as the body of `function (events, agent) { … }`. */
export async function runWakeScript(source: string, input: ScriptInput): Promise<ScriptResult> {
  const started = Date.now();
  if (source.length > SCRIPT_MAX_CHARS) return fail(`the script is longer than ${SCRIPT_MAX_CHARS} characters`, started);
  const runtime = (await quickjs()).newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS));
  const context = runtime.newContext();
  try {
    const payload = context.newString(JSON.stringify(input));
    context.setProp(context.global, "__input", payload);
    payload.dispose();
    // The body becomes a function so `return` works; the input is parsed
    // inside the sandbox, so no host object ever crosses into it.
    const code = `(function (events, agent) {\n"use strict";\n${source}\n})(JSON.parse(__input).events, JSON.parse(__input).agent)`;
    const result = context.evalCode(code, "wake-script.js");
    if (result.error) {
      const error = context.dump(result.error) as { message?: string; name?: string } | string;
      result.error.dispose();
      const message = typeof error === "string" ? error : `${error?.name ?? "Error"}: ${error?.message ?? "failed"}`;
      return fail(/interrupted/i.test(message) ? `the script ran longer than ${TIME_LIMIT_MS} ms` : message, started);
    }
    const value = context.dump(result.value) as unknown;
    result.value.dispose();
    const decision = decisionOf(value);
    return typeof decision === "string" ? fail(decision, started) : { ok: true, decision, ms: Date.now() - started };
  } catch (error) {
    // Out-of-memory and similar runtime failures surface as host exceptions.
    return fail(error instanceof Error ? error.message : String(error), started);
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/** Syntax check without running anything. */
export async function checkWakeScript(source: string): Promise<string | undefined> {
  if (source.length > SCRIPT_MAX_CHARS) return `the script is longer than ${SCRIPT_MAX_CHARS} characters`;
  const runtime = (await quickjs()).newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS));
  const context = runtime.newContext();
  try {
    // Defining the function compiles the body without calling it.
    const result = context.evalCode(`(function (events, agent) {\n"use strict";\n${source}\n}); 0`, "wake-script.js");
    if (!result.error) {
      result.value.dispose();
      return undefined;
    }
    const error = context.dump(result.error) as { message?: string; name?: string };
    result.error.dispose();
    return `${error?.name ?? "SyntaxError"}: ${error?.message ?? "invalid script"}`;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/** The script's view of the events behind a wake. */
export const scriptEvents = (events: readonly AgentEvent[]): ScriptInput["events"] =>
  events.map((event) => ({
    kind: event.kind,
    at: event.at,
    outcome: event.outcome,
    fields: { ...event.fields },
    ...(event.source ? { source: event.source } : {}),
  }));
