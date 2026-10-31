// Background and chat runs. Each run executes on the terminal package's
// contained process runner (the same kernel boundary every Polyth terminal
// uses), hidden from Terminal tab lists, with a bounded output tail. A `chat`
// run then hands the result to a new canonical chat through the injected
// session seam. Runs live in memory: they are progress, not history.
import { randomUUID } from "node:crypto";
import type { SpaceContext } from "@polyth/contracts";
import {
  type ActionChatOptions,
  type ActionRunDto,
  type ActionRunOutputDto,
  type ActionRunStatus,
  type CustomActionDto,
} from "./actionModel.ts";
import { composeChatPrompt } from "./chatPrompt.ts";

/** The slice of the terminal package's service a run needs. */
export interface RunTerminals {
  create(input: {
    projectId: string;
    cwd: string;
    cmd: string;
    cols?: number;
    rows?: number;
    /** Keep the process out of interactive Terminal tab lists. */
    hidden?: boolean;
  }): Promise<{ id: string }>;
  close(id: string): Promise<void>;
  onData(cb: (id: string, data: string) => void): { dispose(): void };
  onExit(cb: (id: string, exitCode: number | null) => void): { dispose(): void };
}

export interface StartChatInput {
  space: SpaceContext;
  projectId: string;
  /** The chat the action was launched from (its checkout is reused). */
  contextSessionId: string | null;
  chat: ActionChatOptions;
  text: string;
}

export interface RunManagerDeps {
  terminals(): RunTerminals | undefined;
  /** Create the chat and send its first message; resolves the new session id.
   *  A rejection whose error carries `sessionId` means the chat exists but its
   *  message was not confirmed. */
  startChat(input: StartChatInput): Promise<string>;
  now?: () => number;
  id?: () => string;
  /** Hard stop for one run. */
  timeoutMs?: number;
  /** Characters of output kept per run (the end of the log). */
  outputLimit?: number;
  /** Concurrent runs per person per Space. */
  maxRunning?: number;
  /** Finished runs kept per person per Space. */
  keepFinished?: number;
  /** Finished runs older than this are forgotten. */
  retentionMs?: number;
  log?: (message: string) => void;
}

export interface StartRunInput {
  space: SpaceContext;
  action: CustomActionDto;
  projectId: string;
  sessionId: string | null;
  cwd: string;
}

export interface RunManager {
  /** Start (or join the already running instance of) an action. */
  start(input: StartRunInput): Promise<{ run: ActionRunDto; joined: boolean }>;
  list(space: SpaceContext): ActionRunDto[];
  output(space: SpaceContext, runId: string, from: number): ActionRunOutputDto;
  stop(space: SpaceContext, runId: string): Promise<ActionRunDto>;
  /** Stop every running process; used when the package is disabled. */
  dispose(): Promise<void>;
}

interface Run {
  dto: ActionRunDto;
  owner: string;
  command: string;
  chat?: ActionChatOptions;
  space: SpaceContext;
  /** Retained output tail and its absolute start offset. */
  output: string;
  outputStart: number;
  terminalId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopReason: "stopped" | "timed-out" | null;
}

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 256_000;

const ownerKey = (space: SpaceContext): string => `${space.spaceId}\u0000${space.userId}`;

const runError = (message: string, code: string, status?: number) =>
  Object.assign(new Error(message), { code, ...(status ? { status } : {}) });

export function createRunManager(deps: RunManagerDeps): RunManager {
  const now = deps.now ?? Date.now;
  const newId = deps.id ?? randomUUID;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const outputLimit = Math.max(1_000, deps.outputLimit ?? DEFAULT_OUTPUT_LIMIT);
  const maxRunning = deps.maxRunning ?? 6;
  const keepFinished = deps.keepFinished ?? 30;
  const retentionMs = deps.retentionMs ?? 12 * 60 * 60_000;

  const runs = new Map<string, Run>();
  const byTerminal = new Map<string, Run>();
  /** Output and exits that arrive while a terminal id is not yet known. */
  let pendingStarts = 0;
  const early = new Map<string, { data: string[]; exit?: number | null }>();
  let subscriptions: Array<{ dispose(): void }> | null = null;
  let subscribedTo: RunTerminals | null = null;

  const append = (run: Run, data: string) => {
    if (!data) return;
    run.output += data;
    run.dto.outputEnd += data.length;
    if (run.output.length > outputLimit) {
      const drop = run.output.length - outputLimit;
      run.output = run.output.slice(drop);
      run.outputStart += drop;
      run.dto.truncated = true;
    }
  };

  const prune = () => {
    const cutoff = now() - retentionMs;
    const finishedByOwner = new Map<string, Run[]>();
    for (const run of runs.values()) {
      if (run.dto.status === "running") continue;
      if ((run.dto.finishedAt ?? 0) < cutoff) {
        runs.delete(run.dto.id);
        continue;
      }
      const list = finishedByOwner.get(run.owner) ?? [];
      list.push(run);
      finishedByOwner.set(run.owner, list);
    }
    for (const list of finishedByOwner.values()) {
      list.sort((a, b) => (b.dto.finishedAt ?? 0) - (a.dto.finishedAt ?? 0));
      for (const stale of list.slice(keepFinished)) runs.delete(stale.dto.id);
    }
  };

  const finish = (run: Run, status: ActionRunStatus, patch: Partial<ActionRunDto> = {}) => {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    Object.assign(run.dto, patch, { status, phase: "done", finishedAt: now() });
    prune();
  };

  const handOff = async (run: Run, exitCode: number | null) => {
    const chat = run.chat ?? { prompt: "", when: "always" as const };
    const commandStatus: ActionRunStatus = run.stopReason ?? (exitCode === 0 ? "succeeded" : "failed");
    const failed = commandStatus !== "succeeded";
    if (run.stopReason === "stopped" || (chat.when === "failure" && !failed) || (chat.when === "success" && failed)) {
      finish(run, run.stopReason === "stopped" ? "stopped" : "succeeded", { exitCode, chatSkipped: true });
      return;
    }
    run.dto.phase = "chat";
    run.dto.exitCode = exitCode;
    try {
      const text = composeChatPrompt({
        prompt: chat.prompt,
        actionName: run.dto.name,
        command: run.command,
        output: run.output,
        outputTruncated: run.dto.truncated,
        status: commandStatus,
        exitCode,
        durationMs: now() - run.dto.startedAt,
      });
      const chatSessionId = await deps.startChat({
        space: run.space,
        projectId: run.dto.projectId,
        contextSessionId: run.dto.sessionId,
        chat,
        text,
      });
      finish(run, "succeeded", { exitCode, chatSessionId });
    } catch (error) {
      const partial = (error as { sessionId?: unknown }).sessionId;
      const message = error instanceof Error && error.message ? error.message : String(error);
      finish(run, "error", {
        exitCode,
        error: `The chat could not be started: ${message}`,
        ...(typeof partial === "string" && partial ? { chatSessionId: partial } : {}),
      });
    }
  };

  const exited = (run: Run, exitCode: number | null) => {
    if (run.dto.status !== "running" || run.dto.phase !== "command") return;
    if (run.terminalId) {
      byTerminal.delete(run.terminalId);
      // Release the exited process's containment boundary.
      const terminalId = run.terminalId;
      void deps.terminals()?.close(terminalId).catch(() => undefined);
    }
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    if (run.dto.mode === "chat") {
      void handOff(run, exitCode);
      return;
    }
    const status: ActionRunStatus = run.stopReason ?? (exitCode === 0 ? "succeeded" : "failed");
    finish(run, status, { exitCode });
  };

  const ensureSubscribed = (terminals: RunTerminals) => {
    if (subscribedTo === terminals) return;
    for (const subscription of subscriptions ?? []) subscription.dispose();
    subscribedTo = terminals;
    subscriptions = [
      terminals.onData((id, data) => {
        const run = byTerminal.get(id);
        if (run) append(run, data);
        else if (pendingStarts > 0) {
          const entry = early.get(id) ?? { data: [] };
          entry.data.push(data);
          early.set(id, entry);
        }
      }),
      terminals.onExit((id, exitCode) => {
        const run = byTerminal.get(id);
        if (run) exited(run, exitCode);
        else if (pendingStarts > 0) {
          const entry = early.get(id) ?? { data: [] };
          entry.exit = exitCode;
          early.set(id, entry);
        }
      }),
    ];
  };

  const visible = (space: SpaceContext, runId: string): Run => {
    const run = runs.get(runId);
    if (!run || run.owner !== ownerKey(space)) throw runError("This run is no longer available.", "not-found");
    return run;
  };

  return {
    async start(input) {
      const owner = ownerKey(input.space);
      const mode = input.action.mode;
      if (mode === "terminal") throw runError("Terminal actions open in Terminal.", "invalid-input");
      for (const run of runs.values()) {
        if (run.owner === owner && run.dto.status === "running"
          && run.dto.actionId === input.action.id && run.dto.projectId === input.projectId) {
          return { run: { ...run.dto }, joined: true };
        }
      }
      const running = [...runs.values()].filter((run) => run.owner === owner && run.dto.status === "running").length;
      if (running >= maxRunning) {
        throw runError(`Up to ${maxRunning} actions can run at once. Wait for one to finish or stop it.`, "resource-limit", 429);
      }
      const terminals = deps.terminals();
      if (!terminals) throw runError("Running commands needs the Terminal package, which is not available.", "unavailable");
      ensureSubscribed(terminals);

      const startedAt = now();
      const run: Run = {
        dto: {
          id: newId(),
          actionId: input.action.id,
          projectId: input.projectId,
          sessionId: input.sessionId,
          name: input.action.name,
          icon: input.action.icon,
          color: input.action.color,
          mode,
          status: "running",
          phase: "command",
          exitCode: null,
          startedAt,
          finishedAt: null,
          chatSessionId: null,
          chatSkipped: false,
          error: null,
          outputEnd: 0,
          truncated: false,
        },
        owner,
        command: input.action.command,
        ...(input.action.chat ? { chat: input.action.chat } : {}),
        space: input.space,
        output: "",
        outputStart: 0,
        terminalId: null,
        timer: null,
        stopReason: null,
      };
      runs.set(run.dto.id, run);

      pendingStarts += 1;
      let terminalId: string;
      try {
        ({ id: terminalId } = await terminals.create({
          projectId: input.projectId,
          cwd: input.cwd,
          cmd: input.action.command,
          cols: 140,
          rows: 40,
          hidden: true,
        }));
      } catch (error) {
        pendingStarts -= 1;
        if (pendingStarts === 0) early.clear();
        const message = error instanceof Error && error.message ? error.message : String(error);
        finish(run, "error", { error: message });
        deps.log?.(`[custom-action] run ${run.dto.id} could not start: ${message}`);
        return { run: { ...run.dto }, joined: false };
      }
      run.terminalId = terminalId;
      byTerminal.set(terminalId, run);
      const buffered = early.get(terminalId);
      early.delete(terminalId);
      pendingStarts -= 1;
      if (pendingStarts === 0) early.clear();
      for (const chunk of buffered?.data ?? []) append(run, chunk);
      run.timer = setTimeout(() => {
        if (run.dto.status !== "running" || run.dto.phase !== "command") return;
        run.stopReason = "timed-out";
        void terminals.close(terminalId).catch(() => {
          // A refused or unconfirmed stop is not proof the process is gone.
          if (run.dto.status !== "running" || run.dto.phase !== "command") return;
          byTerminal.delete(terminalId);
          finish(run, "error", {
            error: "The command passed its time limit and could not be confirmed stopped. It may still be running.",
          });
        });
      }, timeoutMs);
      run.timer.unref?.();
      if (buffered && "exit" in buffered) exited(run, buffered.exit ?? null);
      return { run: { ...run.dto }, joined: false };
    },

    list(space) {
      prune();
      const owner = ownerKey(space);
      return [...runs.values()]
        .filter((run) => run.owner === owner)
        .map((run) => ({ ...run.dto }))
        .sort((a, b) => b.startedAt - a.startedAt);
    },

    output(space, runId, from) {
      const run = visible(space, runId);
      const start = Math.max(Number.isFinite(from) && from > 0 ? Math.floor(from) : 0, run.outputStart);
      const end = run.outputStart + run.output.length;
      return {
        run: { ...run.dto },
        command: run.command,
        start: Math.min(start, end),
        end,
        text: start >= end ? "" : run.output.slice(start - run.outputStart),
      };
    },

    async stop(space, runId) {
      const run = visible(space, runId);
      if (run.dto.status !== "running") return { ...run.dto };
      if (run.dto.phase !== "command" || !run.terminalId) {
        // The command already finished; a chat hand-off in flight is not undone.
        return { ...run.dto };
      }
      run.stopReason = "stopped";
      const terminals = deps.terminals();
      try {
        await terminals?.close(run.terminalId);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : String(error);
        throw runError(`The command could not be stopped: ${message}`, "unavailable");
      }
      return { ...run.dto };
    },

    async dispose() {
      const terminals = subscribedTo;
      const active = [...runs.values()].filter((run) => run.dto.status === "running" && run.terminalId);
      for (const run of active) {
        run.stopReason = "stopped";
        await terminals?.close(run.terminalId!).catch(() => undefined);
      }
      for (const run of runs.values()) if (run.timer) clearTimeout(run.timer);
      for (const subscription of subscriptions ?? []) subscription.dispose();
      subscriptions = null;
      subscribedTo = null;
      byTerminal.clear();
      early.clear();
    },
  };
}
