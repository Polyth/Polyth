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
import type {
  AgentDescriptor,
  AgentRuntime,
  CanonicalTurnRequest,
  CreateSessionInput,
  Disposable,
  JsonObject,
  ModelDescriptor,
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

const CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  permissions: true,
  questions: true,
  compaction: true,
  subagents: true,
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
}

interface AgentRow {
  name: string;
  description?: string;
  mode?: string;
}

interface CreatedSession {
  id: string;
}

const flattenModels = (body: ProviderList): ModelDescriptor[] => {
  const out: ModelDescriptor[] = [];
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
        context: model.limit?.context,
        cost,
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

const spawnServe = async (
  opts: OpenCodeAdapterOptions,
): Promise<{ child: ChildProcess; port: number; hostname: string }> => {
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? (await freePort(hostname));
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

const killChild = async (child: ChildProcess | undefined): Promise<void> => {
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
}

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
    async ensureSession(canonical: CreateSessionInput & { sessionId: string; cwd: string }) {
      const existing = maps.forward.get(canonical.sessionId);
      if (existing) {
        maps.reverse.set(existing, canonical.sessionId);
        return;
      }
      const created = await client.post<CreatedSession>("/session", {
        title: canonical.title ?? canonical.sessionId,
      });
      maps.forward.set(canonical.sessionId, created.id);
      maps.reverse.set(created.id, canonical.sessionId);
    },
    async startTurn(req: CanonicalTurnRequest) {
      const backendId = backendOf(req.sessionId);
      if (!activeTurn.has(req.sessionId)) {
        const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        activeTurn.set(req.sessionId, { turnId, aborting: false });
        emit(req.sessionId, { type: "turn/started", turnId });
      }
      const body: JsonObject = {
        parts: [{ type: "text", text: req.text }],
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
      await killChild(child);
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
    await killChild(child);
    throw err;
  }
  return createOpenCodeRuntimeWithClient(client, opts, child);
};
