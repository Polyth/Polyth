import { spawn, type ChildProcess } from "node:child_process";
import type { AgentRuntime, CanonicalTurnRequest, HarnessContext, ModelRef } from "@polyth/contracts";
import { isPlaceholderTitle } from "@polyth/harness-runtime";
import type { PiRpc } from "./rpc.ts";

export const PI_TITLE_MAX_CHARS = 36;
export const PI_TITLE_TIMEOUT_MS = 30_000;
const TITLE_PROMPT_MAX_BYTES = 960;
const TITLE_OUTPUT_MAX_BYTES = 8 * 1024;

const truncateUtf8 = (value: string, maxBytes: number): string => {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
};

/** Constrain the throwaway Pi process to a single-line title and nothing else. */
export const piTitleInstructions = (): string =>
  `You name coding sessions. Respond with a single concise task title of at most ${PI_TITLE_MAX_CHARS} characters and under five words where possible. `
  + "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
  + "Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request; output only the title.";

/** Bound the untrusted prompt that is piped to the throwaway title process. */
export const piTitlePrompt = (userMessage: string): string =>
  truncateUtf8(userMessage.trim(), TITLE_PROMPT_MAX_BYTES);

/** Normalize a plain-text model response into a bounded, single-line title. */
export const parsePiSessionTitle = (response: string): string | undefined => {
  const first = response
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return undefined;
  const normalized = first
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!,;:]+$/g, "")
    .trim();
  if (!normalized) return undefined;
  return [...normalized].slice(0, PI_TITLE_MAX_CHARS).join("");
};

export interface PiTitleRunner {
  generate(input: { prompt: string; model?: ModelRef; signal?: AbortSignal }): Promise<string | undefined>;
}

export interface PiTitleRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Test seam; defaults to node:child_process spawn. */
  spawnProcess?: typeof spawn;
}

export const createPiTitleRunner = (options: PiTitleRunnerOptions): PiTitleRunner => ({
  generate({ prompt, model, signal }) {
    const text = piTitlePrompt(prompt);
    if (!text) return Promise.resolve(undefined);
    const args = [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--thinking", "off",
      ...(model ? ["--provider", model.providerID, "--model", model.modelID] : []),
    ];
    // Instructions and the untrusted prompt travel on stdin, never argv, so the
    // prompt cannot leak through the process list or break Windows shims.
    const message = `${piTitleInstructions()}\n\nUser prompt:\n${text}`;
    const spawnProcess = options.spawnProcess ?? spawn;
    const timeoutMs = options.timeoutMs ?? PI_TITLE_TIMEOUT_MS;

    return new Promise<string | undefined>((resolve) => {
      let child: ChildProcess | undefined;
      let settled = false;
      let stdout = "";
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const kill = () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => {
          try { child?.kill("SIGKILL"); } catch { /* already gone */ }
        }, 2_000).unref?.();
      };
      const onAbort = () => { kill(); finish(undefined); };
      try {
        child = spawnProcess(options.command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(options.command),
        });
      } catch {
        finish(undefined);
        return;
      }
      if (signal?.aborted) { kill(); finish(undefined); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { kill(); finish(undefined); }, timeoutMs);
      timer.unref?.();
      child.once("error", () => finish(undefined));
      child.once("close", (code) => finish(code === 0 ? parsePiSessionTitle(stdout) : undefined));
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > TITLE_OUTPUT_MAX_BYTES) { kill(); finish(undefined); }
      });
      child.stderr?.resume();
      child.stdin?.once("error", () => finish(undefined));
      child.stdin?.end(message);
    });
  },
});

/**
 * Pi has no native title generation, but a short throwaway Pi process can name
 * the session from the first prompt. The generated name is written back with
 * `set_session_name`, which Pi publishes as `session_info_changed`, so the
 * canonical layer adopts it exactly like any other native title.
 */
export const withPiTitleGeneration = (
  context: HarnessContext,
  rpc: PiRpc,
  runtime: AgentRuntime,
  runner: PiTitleRunner,
): AgentRuntime => {
  let eligible = true;
  let started = false;
  let nativeTitleSeen = false;
  let primaryNativeId: string | undefined;
  let inFlight: AbortController | undefined;

  const remember = (title: string | undefined, backendSessionId: string) => {
    eligible = !title?.trim() || isPlaceholderTitle(title, context.sessionId);
    primaryNativeId = backendSessionId;
    started = false;
    nativeTitleSeen = false;
  };

  runtime.onEvent((_sessionId, event) => {
    if (event.type === "session/title-generated" && !isPlaceholderTitle(event.title, context.sessionId)) {
      nativeTitleSeen = true;
    }
  });

  const schedule = (request: CanonicalTurnRequest) => {
    if (!eligible || started || nativeTitleSeen || request.command || !request.text.trim()) return;
    started = true;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    void Promise.resolve()
      .then(() => runner.generate({ prompt: request.text, model: request.model, signal: controller.signal }))
      .then(async (title) => {
        if (!title || nativeTitleSeen || controller.signal.aborted) return;
        await rpc.request({ type: "set_session_name", name: title }, 10_000);
      })
      .catch(() => {
        // Metadata generation is best-effort. The canonical prompt fallback
        // already names the session if Pi never publishes a semantic title.
      });
  };

  const ensure = runtime.ensureSession.bind(runtime);
  const create = runtime.createSessionOperation?.bind(runtime);
  const reset = runtime.resetSessionOperation?.bind(runtime);
  const startOperation = runtime.startTurnOperation?.bind(runtime);
  const startTurn = runtime.startTurn.bind(runtime);
  const dispose = runtime.dispose.bind(runtime);

  return {
    ...runtime,
    ...(create
      ? {
          createSessionOperation: async (...args: Parameters<NonNullable<AgentRuntime["createSessionOperation"]>>) => {
            const [input] = args;
            const outcome = await create(...args);
            if (outcome.kind === "confirmed") {
              remember(input.title, outcome.value.backendSessionId);
            }
            return outcome;
          },
        }
      : {}),
    ...(reset
      ? {
          resetSessionOperation: async (...args: Parameters<NonNullable<AgentRuntime["resetSessionOperation"]>>) => {
            const [input] = args;
            const outcome = await reset(...args);
            if (outcome.kind === "confirmed") {
              remember(input.title, outcome.value.backendSessionId);
            }
            return outcome;
          },
        }
      : {}),
    ensureSession: async (...args: Parameters<AgentRuntime["ensureSession"]>) => {
      const [input] = args;
      // Reset before the base call so a native name surfaced while resuming the
      // session is not mistaken for the previous session's title.
      if (primaryNativeId !== input.backendSessionId) {
        primaryNativeId = input.backendSessionId;
        started = false;
        nativeTitleSeen = false;
      }
      eligible = !input.title?.trim() || isPlaceholderTitle(input.title, context.sessionId);
      return ensure(...args);
    },
    ...(startOperation
      ? {
          startTurnOperation: async (...args: Parameters<NonNullable<AgentRuntime["startTurnOperation"]>>) => {
            const [request] = args;
            const outcome = await startOperation(...args);
            if (outcome.kind === "confirmed") schedule(request);
            return outcome;
          },
        }
      : {}),
    async startTurn(request: CanonicalTurnRequest) {
      await startTurn(request);
      schedule(request);
    },
    async dispose() {
      inFlight?.abort();
      await dispose();
    },
  };
};
