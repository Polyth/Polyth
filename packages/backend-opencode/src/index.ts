/*
OpenCode 1.18.18 serve API (empirically verified 2026-08-17 against
`opencode serve --port 4556 --hostname 127.0.0.1` + GET /doc + bundled SDK
~/.opencode/node_modules/@opencode-ai/sdk).

Auth: when OPENCODE_SERVER_PASSWORD is set, HTTP Basic user `opencode`.
Listening line: `opencode server listening on http://127.0.0.1:<port>`

Endpoint map (verified):
  GET  /global/health                         → {healthy:true, version:"1.18.18"}
  GET  /api/health                            → {healthy:true}
  GET  /health                                → HTML SPA (not a JSON probe)
  GET  /provider                              → {all:[{id,name,models:{[id]:{id,name,limit:{context,output},cost:{input,output}}}}], default, connected:string[]}
  GET  /config/providers                      → {providers:[...], default}
  GET  /agent                                 → [{name, description?, mode:"primary"|"subagent"|"all", ...}]
  POST /session  {title?}                     → {id:"ses_...", projectID, directory, title, version, time:{created,updated}, tokens, cost, slug?}
  GET  /session                               → Session[]
  POST /session/{id}/message                  {parts:[{type:"text",text}], model?:{providerID,modelID}, agent?}
  POST /session/{id}/prompt_async             same body; returns immediately (used for startTurn)
  POST /session/{id}/abort
  POST /session/{id}/fork
  POST /session/{id}/permissions/{permissionID}  {response:"once"|"always"|"reject"}
       permissionID pattern ^per  (SDK + live 400 if not)
  GET  /question                              pending QuestionRequest[]
  POST /question/{requestID}/reply            {answers: string[][]}  requestID ^que
  POST /question/{requestID}/reject           (no body)
  GET  /event                                 SSE text/event-stream
  GET  /doc                                   OpenAPI

NOT present: POST /session/{id}/questions/{requestID} (SPA HTML fallback).

SSE event names observed live (JSON `data:` objects, field `id` = evt_…; no SSE `id:` lines):
  server.connected
  session.created / session.updated / session.diff / session.status {type:busy|idle} / session.idle / session.error
  message.updated  properties.info  (role user|assistant; assistant has cost, tokens, time.completed?)
  message.part.updated  properties.{sessionID, part:{id,type,text|state,...}, delta?, time}
  message.part.delta    properties.{sessionID,messageID,partID,field:"text"|"reasoning",delta}
  permission.updated (SDK) / permission.asked (OpenAPI) / permission.replied
  question.asked / question.replied / question.rejected
  plugin.added, catalog.updated, … (ignored)
*/

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentDescriptor,
  AgentRuntime,
  AttachmentRef,
  CanonicalTurnRequest,
  CreateSessionInput,
  Disposable,
  JsonObject,
  ModelDescriptor,
  RuntimeSession,
  RuntimeSessionMessage,
  RuntimeCapabilities,
  RuntimeEvent,
} from "@polyth/contracts";
import { createOpenCodeClient, type OpenCodeClient } from "./client.ts";
import {
  asOcEvent,
  backendSessionId,
  createTranslateState,
  errorMessageOf,
  flushAssistantOnIdle,
  isIdleEvent,
  translateOcEvent,
  type TranslateState,
} from "./events.ts";

export interface OpenCodeAdapterOptions {
  cwd: string;
  port?: number;
  hostname?: string;
  bin?: string;
  dataDir?: string;
}

export { createOpenCodeClient } from "./client.ts";
export type { OpenCodeClient } from "./client.ts";
export { createConfigApplier } from "./config.ts";
export type { BackendConfigApplier, McpApplyEntry } from "./config.ts";

const CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  permissions: true,
  questions: true,
  compaction: true,
  subagents: true,
  // live steering: a prompt posted to a busy session joins the active turn;
  // steer() reports false on rejection so callers can fall back to queueing
  steering: true,
};

const LISTEN_RE = /opencode server listening on https?:\/\/[^\s:]+:(\d+)/i;

type Listener = (sessionId: string, ev: RuntimeEvent) => void;

interface SessionMaps {
  forward: Map<string, string>;
  reverse: Map<string, string>;
}

const mapsFrom = (sessionIdMap?: Map<string, string>): SessionMaps => {
  const forward = sessionIdMap ?? new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const [canonical, backend] of forward) reverse.set(backend, canonical);
  return { forward, reverse };
};

interface ProviderList {
  all?: Array<{
    id: string;
    name?: string;
    models?: Record<
      string,
      {
        id?: string;
        name?: string;
        limit?: { context?: number };
        cost?: { input?: number; output?: number };
      }
    >;
  }>;
  /** Provider ids with live credentials. Empty/missing = unknown. */
  connected?: string[];
}

interface AgentRow {
  name: string;
  description?: string;
  mode?: string;
}

interface CreatedSession {
  id: string;
}

interface OpenCodeSession {
  id: string;
  title?: string;
  parentID?: string;
  time?: { created?: number; updated?: number };
}

interface OpenCodeMessage {
  info?: { role?: string };
  parts?: Array<{ type?: string; text?: string }>;
}

export const flattenModels = (body: ProviderList): ModelDescriptor[] => {
  const out: ModelDescriptor[] = [];
  // When `connected` is empty or missing the backend gave us no signal —
  // treat every provider as connected rather than hiding everything.
  const connectedIds = new Set(body.connected ?? []);
  const hasSignal = connectedIds.size > 0;
  for (const provider of body.all ?? []) {
    const models = provider.models ?? {};
    for (const [key, model] of Object.entries(models)) {
      const cost =
        model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number"
          ? { input: model.cost.input, output: model.cost.output }
          : undefined;
      out.push({
        providerID: provider.id,
        modelID: model.id ?? key,
        name: model.name ?? key,
        ...(provider.name ? { providerName: provider.name } : {}),
        context: model.limit?.context,
        cost,
        connected: hasSignal ? connectedIds.has(provider.id) : true,
      });
    }
  }
  return out;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitReady = async (client: OpenCodeClient, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    for (const path of ["/global/health", "/api/health", "/agent", "/provider"]) {
      try {
        await client.get(path);
        return;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
    }
    await sleep(200);
  }
  throw new Error(`opencode serve not ready within ${timeoutMs}ms (${last})`);
};

/** Ask the OS for a free port: one `opencode serve` per project/worktree means
 *  a fixed port would make the second runtime fail with EADDRINUSE. */
const freePort = (hostname: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, hostname, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });

// One `opencode serve` per project cwd. A hard kill of the polyth process
// (crash, SIGKILL) leaves the child reparented to init — it never dies on
// its own. Track it in a pidfile keyed by cwd so the next spawn for that
// cwd reaps its orphaned predecessor instead of leaking forever. The file
// records `<owner pid> <child pid>`: only a *foreign* owner marks an orphan,
// so a second spawn can never shoot down a live sibling of this process.
const pidFileFor = (cwd: string): string => {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) | 0;
  const dir = join(tmpdir(), "polyth-opencode");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${(h >>> 0).toString(36)}.pid`);
};

const readPidFile = (pidFile: string): { owner: number; child: number } | undefined => {
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf8");
  } catch {
    return undefined;
  }
  const parts = raw.trim().split(/\s+/).map(Number);
  // Legacy single-pid files predate the owner column; treat them as foreign.
  const [owner, child] = parts.length >= 2 ? parts : [0, parts[0]];
  if (!Number.isFinite(child) || !child || child <= 0) return undefined;
  return { owner: Number.isFinite(owner) ? owner! : 0, child: child! };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const reapOrphan = (pidFile: string): void => {
  const rec = readPidFile(pidFile);
  if (!rec) {
    rmSync(pidFile, { force: true });
    return;
  }
  // Our own live child is in use by another runtime for this cwd, not an
  // orphan — leave it running and let the caller overwrite the file.
  if (rec.owner === process.pid && alive(rec.child)) return;
  try {
    process.kill(rec.child, "SIGKILL");
  } catch {
    /* already dead */
  }
  rmSync(pidFile, { force: true });
};

const spawnServe = async (
  opts: OpenCodeAdapterOptions,
): Promise<{ child: ChildProcess; port: number; hostname: string }> => {
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? (await freePort(hostname));
  const pidFile = pidFileFor(opts.cwd);
  reapOrphan(pidFile);
  return new Promise((resolve, reject) => {
    const bin = opts.bin ?? "opencode";
    const env = { ...process.env };
    if (opts.dataDir) env.OPENCODE_CONFIG_DIR = opts.dataDir;
    const child = spawn(bin, ["serve", "--hostname", hostname, "--port", String(port)], {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let buf = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("opencode serve listen timeout"));
    }, 20_000);
    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(LISTEN_RE);
      if (m && !settled) {
        settled = true;
        clearTimeout(timeout);
        if (child.pid) writeFileSync(pidFile, `${process.pid} ${child.pid}`);
        resolve({ child, port: Number(m[1]), hostname });
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`opencode serve exited ${code}: ${buf.slice(-400)}`));
    });
  });
};

const killChild = async (child: ChildProcess | undefined, cwd?: string): Promise<void> => {
  // Only drop the pidfile if it still tracks *this* child: a later runtime for
  // the same cwd may already own it, and that one still needs reaping later.
  if (cwd) {
    const pidFile = pidFileFor(cwd);
    if (!child?.pid || readPidFile(pidFile)?.child === child.pid) rmSync(pidFile, { force: true });
  }
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.once("exit", () => r(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
};

export interface OpenCodeRuntimeExtras {
  client?: OpenCodeClient;
  sessionIdMap?: Map<string, string>;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject) => void;
  cwd?: string;
}

/** F2: canonical AttachmentRefs → OpenCode message parts.
 *  - file/image/range → `{type:"file", url:"file://…"}`; OpenCode reads the
 *    bytes locally (ranges via verified `?start=&end=` query params).
 *  - url → a plain text part carrying the link. Never a file part: the server
 *    side must not fetch foreign URLs (browser-package origin policy).
 *  Paths outside the session cwd are skipped — defense in depth on top of the
 *  server-side validation. */
export const attachmentParts = (
  attachments: AttachmentRef[] | undefined,
  cwd: string | undefined,
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject) => void,
): JsonObject[] => {
  const parts: JsonObject[] = [];
  for (const a of attachments ?? []) {
    if (a.kind === "url") {
      if (!a.url || !/^https?:\/\//i.test(a.url)) continue;
      parts.push({ type: "text", text: `[Attached link: ${a.name}] ${a.url}` });
      continue;
    }
    if (!a.path || !cwd) continue;
    const rootAbs = resolve(cwd);
    const abs = resolve(rootAbs, a.path);
    const rel = relative(rootAbs, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      log?.("warn", "attachment path escapes session cwd; skipped", { path: a.path });
      continue;
    }
    let url = pathToFileURL(abs).href;
    if (a.kind === "range" && a.range) url += `?start=${a.range[0]}&end=${a.range[1]}`;
    parts.push({ type: "file", mime: a.mime, filename: a.name, url });
  }
  return parts;
};

export const createOpenCodeRuntimeWithClient = (
  client: OpenCodeClient,
  extras: OpenCodeRuntimeExtras = {},
  child?: ChildProcess,
): AgentRuntime => {
  const maps = mapsFrom(extras.sessionIdMap);
  const listeners = new Set<Listener>();
  const translate = new Map<string, TranslateState>();
  const activeTurn = new Map<string, { turnId: string; aborting: boolean }>();
  const seenEventIds = new Set<string>();
  const log = extras.log ?? ((level, msg, data) => {
    if (level === "debug") console.debug(msg, data ?? "");
  });

  let sseAbort: AbortController | undefined;
  let disposed = false;

  const emit = (canonical: string, ev: RuntimeEvent) => {
    for (const cb of listeners) cb(canonical, ev);
  };

  const stateFor = (canonical: string): TranslateState => {
    let s = translate.get(canonical);
    if (!s) {
      s = createTranslateState();
      translate.set(canonical, s);
    }
    return s;
  };

  const handlePayload = (id: string | undefined, data: unknown) => {
    const ev = asOcEvent(data);
    if (!ev) return;
    const eid = id ?? ev.id;
    if (eid) {
      if (seenEventIds.has(eid)) return;
      seenEventIds.add(eid);
      if (seenEventIds.size > 8000) {
        const first = seenEventIds.values().next().value;
        if (first) seenEventIds.delete(first);
      }
    }
    const backendId = backendSessionId(ev);
    if (!backendId) return;
    const canonical = maps.reverse.get(backendId);
    if (!canonical) {
      log("debug", "opencode event for unmapped session", { backendId, type: ev.type ?? "" });
      return;
    }
    const st = stateFor(canonical);
    for (const runtimeEv of translateOcEvent(ev, st)) emit(canonical, runtimeEv);
    const err = errorMessageOf(ev);
    if (err) {
      const turn = activeTurn.get(canonical);
      if (turn) {
        activeTurn.delete(canonical);
        emit(canonical, { type: "turn/stopped", reason: "error", error: err });
      }
      return;
    }
    if (isIdleEvent(ev)) {
      for (const runtimeEv of flushAssistantOnIdle(st)) emit(canonical, runtimeEv);
      const turn = activeTurn.get(canonical);
      if (turn) {
        activeTurn.delete(canonical);
        emit(canonical, {
          type: "turn/stopped",
          reason: turn.aborting ? "aborted" : "completed",
        });
      }
    }
  };

  const connectSse = async () => {
    let delay = 500;
    while (!disposed) {
      sseAbort = new AbortController();
      try {
        await client.streamEvents(sseAbort.signal, ({ id, data }) => handlePayload(id, data));
      } catch (err) {
        if (disposed) return;
        if ((err as { name?: string }).name === "AbortError") return;
        log("debug", "opencode sse disconnected", { error: String(err) });
      }
      if (disposed) return;
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  };

  void connectSse();

  const backendOf = (sessionId: string): string => {
    const id = maps.forward.get(sessionId);
    if (!id) throw new Error(`no opencode session mapped for ${sessionId}`);
    return id;
  };

  return {
    capabilities: async () => CAPABILITIES,
    async models() {
      const body = await client.get<ProviderList>("/provider");
      return flattenModels(body);
    },
    async agents() {
      const rows = await client.get<AgentRow[]>("/agent");
      return (rows ?? []).map(
        (a): AgentDescriptor => ({
          name: a.name,
          description: a.description,
          mode: a.mode === "subagent" || a.mode === "all" || a.mode === "primary" ? a.mode : "primary",
        }),
      );
    },
    async sessions(): Promise<RuntimeSession[]> {
      const rows = await client.get<OpenCodeSession[]>("/session");
      return (rows ?? []).map((session) => ({
        id: session.id,
        title: session.title || "Untitled session",
        ...(session.parentID ? { parentId: session.parentID } : {}),
        createdAt: session.time?.created ?? Date.now(),
        updatedAt: session.time?.updated ?? session.time?.created ?? Date.now(),
      }));
    },
    async history(sessionId: string): Promise<RuntimeSessionMessage[]> {
      const rows = await client.get<OpenCodeMessage[]>(`/session/${sessionId}/message?limit=50`);
      return (rows ?? []).flatMap((message) => {
        const role = message.info?.role;
        if (role !== "user" && role !== "assistant") return [];
        const text = (message.parts ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").slice(0, 20_000);
        const reasoning = (message.parts ?? []).filter((part) => part.type === "reasoning").map((part) => part.text ?? "").join("\n").slice(0, 5_000);
        return text || reasoning ? [{ role, text, ...(reasoning ? { reasoning } : {}) }] : [];
      });
    },
    async ensureSession(canonical: CreateSessionInput & { sessionId: string; cwd: string }) {
      const existing = maps.forward.get(canonical.sessionId);
      if (existing) {
        maps.reverse.set(existing, canonical.sessionId);
        return existing;
      }
      if (canonical.backendSessionId) {
        maps.forward.set(canonical.sessionId, canonical.backendSessionId);
        maps.reverse.set(canonical.backendSessionId, canonical.sessionId);
        return canonical.backendSessionId;
      }
      const created = await client.post<CreatedSession>("/session", {
        title: canonical.title ?? canonical.sessionId,
      });
      maps.forward.set(canonical.sessionId, created.id);
      maps.reverse.set(created.id, canonical.sessionId);
      return created.id;
    },
    async resetSession(canonical: CreateSessionInput & { sessionId: string; cwd: string }) {
      const previous = maps.forward.get(canonical.sessionId);
      if (previous) maps.reverse.delete(previous);
      maps.forward.delete(canonical.sessionId);
      translate.delete(canonical.sessionId);
      activeTurn.delete(canonical.sessionId);
      const created = await client.post<CreatedSession>("/session", {
        title: canonical.title ?? canonical.sessionId,
      });
      maps.forward.set(canonical.sessionId, created.id);
      maps.reverse.set(created.id, canonical.sessionId);
      return created.id;
    },
    async startTurn(req: CanonicalTurnRequest) {
      const backendId = backendOf(req.sessionId);
      if (!activeTurn.has(req.sessionId)) {
        const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        activeTurn.set(req.sessionId, { turnId, aborting: false });
        emit(req.sessionId, { type: "turn/started", turnId });
      }
      const body: JsonObject = {
        parts: [
          { type: "text", text: req.text },
          ...attachmentParts(req.attachments, extras.cwd, log),
        ],
      };
      if (req.model) {
        body.model = { providerID: req.model.providerID, modelID: req.model.modelID };
      }
      if (req.agent) body.agent = req.agent;
      try {
        await client.post(`/session/${backendId}/prompt_async`, body);
      } catch {
        await client.post(`/session/${backendId}/message`, body);
      }
    },
    async steer(sessionId: string, text: string): Promise<boolean> {
      // Only meaningful while a turn is active; posting to an idle session
      // would start a fresh turn instead of steering.
      if (!activeTurn.has(sessionId)) return false;
      let backendId: string;
      try {
        backendId = backendOf(sessionId);
      } catch {
        return false;
      }
      try {
        await client.post(`/session/${backendId}/prompt_async`, {
          parts: [{ type: "text", text }],
        });
        return true;
      } catch {
        return false; // backend rejected live steering — caller queues
      }
    },
    async abort(sessionId: string) {
      const backendId = backendOf(sessionId);
      const turn = activeTurn.get(sessionId);
      if (turn) turn.aborting = true;
      await client.post(`/session/${backendId}/abort`);
    },
    async replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject") {
      const backendId = backendOf(sessionId);
      await client.post(`/session/${backendId}/permissions/${requestId}`, { response: reply });
    },
    async replyQuestion(sessionId: string, requestId: string, answers: JsonObject) {
      backendOf(sessionId);
      if (answers.action === "reject") {
        await client.post(`/question/${requestId}/reject`);
        return;
      }
      const list = Array.isArray(answers.answers) ? answers.answers : [answers];
      await client.post(`/question/${requestId}/reply`, { answers: list });
    },
    onEvent(cb: Listener): Disposable {
      listeners.add(cb);
      return { dispose: () => { listeners.delete(cb); } };
    },
    async dispose() {
      disposed = true;
      sseAbort?.abort();
      await killChild(child, extras.cwd);
    },
  };
};

export const createOpenCodeRuntime = async (
  opts: OpenCodeAdapterOptions & OpenCodeRuntimeExtras,
): Promise<AgentRuntime> => {
  if (opts.client) {
    return createOpenCodeRuntimeWithClient(opts.client, opts);
  }
  const { child, port, hostname } = await spawnServe(opts);
  const client = createOpenCodeClient(`http://${hostname}:${port}`, { directory: opts.cwd });
  try {
    await waitReady(client, 20_000);
  } catch (err) {
    await killChild(child, opts.cwd);
    throw err;
  }
  return createOpenCodeRuntimeWithClient(client, opts, child);
};
