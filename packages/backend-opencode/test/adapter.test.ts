import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { ModelMessage, RuntimeEvent } from "@polyth/contracts";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
  flattenModels,
} from "../src/index.ts";
import {
  admitTranslateTurn,
  claimTerminalStateEvidence,
  createTranslateState,
  flushAssistantOnIdle,
  normalizeOcObservation,
  translateOcEvent,
} from "../src/events.ts";

interface ScriptedEvent {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

const providerBody = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "big-pickle": {
          id: "big-pickle",
          name: "Big Pickle",
          limit: { context: 128000, output: 8192 },
          cost: { input: 0, output: 0 },
        },
      },
    },
  ],
  default: { opencode: "big-pickle" },
  connected: ["opencode"],
};

const agentsBody = [
  { name: "build", description: "default", mode: "primary" },
  { name: "explore", description: "search", mode: "subagent" },
  { name: "auto", description: "caller supplies the model", mode: "subagent", options: { "polyth.mode": "auto" } },
];

const scriptedSequence = (sessionID: string): ScriptedEvent[] => [
  {
    id: "evt_1",
    type: "session.status",
    properties: { sessionID, status: { type: "busy" } },
  },
  {
    id: "evt_2",
    type: "message.updated",
    properties: {
      sessionID,
      info: { id: "msg_user", role: "user", sessionID },
    },
  },
  {
    id: "evt_3",
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID: "msg_asst",
      partID: "prt_text",
      field: "text",
      delta: "Hel",
    },
  },
  {
    id: "evt_4",
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID: "msg_asst",
      partID: "prt_text",
      field: "text",
      delta: "lo",
    },
  },
  {
    id: "evt_5",
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        id: "prt_text",
        type: "text",
        text: "Hello",
        messageID: "msg_asst",
        sessionID,
        time: { start: 1, end: 2 },
      },
    },
  },
  {
    id: "evt_6",
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        id: "prt_tool",
        type: "tool",
        callID: "call_1",
        tool: "bash",
        messageID: "msg_asst",
        sessionID,
        state: { status: "running", input: { command: "ls" }, raw: "" },
      },
    },
  },
  {
    id: "evt_7",
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        id: "prt_tool",
        type: "tool",
        callID: "call_1",
        tool: "bash",
        messageID: "msg_asst",
        sessionID,
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "ok",
          title: "ls",
          metadata: { exit: 0 },
        },
      },
    },
  },
  {
    id: "evt_8",
    type: "permission.asked",
    properties: {
      id: "per_abc",
      sessionID,
      permission: "bash",
      patterns: ["ls"],
      metadata: { cwd: "/tmp" },
      tool: { messageID: "msg_asst", callID: "call_1" },
    },
  },
  {
    id: "evt_9",
    type: "question.asked",
    properties: {
      id: "que_1",
      sessionID,
      questions: [{ question: "Continue?", header: "cont", options: [] }],
    },
  },
  {
    id: "evt_10",
    type: "session.idle",
    properties: { sessionID, revision: 123 },
  },
];

const sseFrame = (ev: ScriptedEvent) =>
  `data: ${JSON.stringify(ev)}\n\n`;

const startFake = async () => {
  let sessionSeq = 0;
  const sseClients: http.ServerResponse[] = [];
  let posted = false;
  const postedBodies: Array<Record<string, unknown>> = [];
  const sessionCreateBodies: Array<Record<string, unknown>> = [];
  const permissionReplies: unknown[] = [];
  const questionReplies: unknown[] = [];
  let aborts = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && path === "/global/health") return json(200, { healthy: true, version: "fake" });
    if (req.method === "GET" && path === "/doc") {
      return json(200, {
        paths: {
          "/session/{sessionID}/prompt_async": { post: {} },
          "/session/{sessionID}/message": { post: {} },
        },
      });
    }
    if (req.method === "GET" && path === "/provider") return json(200, providerBody);
    if (req.method === "GET" && path === "/agent") return json(200, agentsBody);
    if (req.method === "POST" && path === "/session") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        sessionCreateBodies.push(JSON.parse(raw || "{}") as Record<string, unknown>);
        sessionSeq += 1;
        json(200, { id: `ses_fake_${sessionSeq}`, title: "t", directory: "/tmp" });
      });
      return;
    }
    if (req.method === "GET" && path === "/session") return json(200, []);
    if (req.method === "GET" && path.match(/^\/session\/[^/]+\/message$/)) return json(200, []);
    const msg = path.match(/^\/session\/([^/]+)\/(message|prompt_async)$/);
    if (req.method === "POST" && msg) {
      const sessionID = msg[1]!;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        postedBodies.push(JSON.parse(raw || "{}") as Record<string, unknown>);
        posted = true;
        json(200, { ok: true });
        setTimeout(() => {
          for (const ev of scriptedSequence(sessionID)) {
            const frame = sseFrame(ev);
            for (const c of sseClients) c.write(frame);
          }
        }, 40);
      });
      return;
    }
    const perm = path.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
    if (req.method === "POST" && perm) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        permissionReplies.push(JSON.parse(raw || "{}"));
        json(200, true);
      });
      return;
    }
    const qreply = path.match(/^\/question\/([^/]+)\/reply$/);
    if (req.method === "POST" && qreply) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        questionReplies.push(JSON.parse(raw || "{}"));
        json(200, true);
      });
      return;
    }
    if (req.method === "POST" && path.match(/^\/question\/[^/]+\/reject$/)) {
      questionReplies.push({ action: "reject" });
      return json(200, true);
    }
    if (req.method === "POST" && path.match(/^\/session\/[^/]+\/abort$/)) {
      aborts += 1;
      return json(200, true);
    }
    if (req.method === "GET" && path === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sseClients.push(res);
      res.write(sseFrame({ id: "evt_hello", type: "server.connected", properties: {} }));
      req.on("close", () => {
        const i = sseClients.indexOf(res);
        if (i >= 0) sseClients.splice(i, 1);
      });
      return;
    }
    json(404, { error: path });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    server,
    sseClients,
    get posted() {
      return posted;
    },
    postedBodies,
    sessionCreateBodies,
    permissionReplies,
    questionReplies,
    get aborts() {
      return aborts;
    },
    replay(ev: ScriptedEvent) {
      const frame = sseFrame(ev);
      for (const c of sseClients) c.write(frame);
    },
  };
};

const waitUntil = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
};

const createTestRuntime = async (baseUrl: string, cwd = "/tmp") => {
  const lease = await createBorrowedExternalEndpointLease({
    url: baseUrl,
    location: { directory: cwd },
    authorityId: `adapter-test:${baseUrl}`,
  });
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "legacy",
    protocolDeadlineMs: 500,
    startupDeadlineMs: 500,
    probeDeadlineMs: 100,
    transport: { queryAttempts: 1 },
  });
  const facade = createOpenCodeRuntimeFacade({ cwd, lifecycle });
  const disposeFacade = facade.dispose.bind(facade);
  facade.dispose = async () => {
    await disposeFacade();
    await lifecycle.dispose();
  };
  return attachRuntimeLifecycle(facade, lifecycle);
};

test("models/agents flatten from verified /provider and /agent shapes", async () => {
  const fake = await startFake();
  const runtime = await createTestRuntime(fake.baseUrl);
  try {
    const models = await runtime.models();
    assert.equal(models[0]?.providerID, "opencode");
    assert.equal(models[0]?.modelID, "big-pickle");
    assert.equal(models[0]?.context, 128000);
    assert.deepEqual(models[0]?.cost, { input: 0, output: 0 });
    assert.equal(models[0]?.connected, true, "provider in connected[] is marked connected");
    assert.equal(models[0]?.providerName, "OpenCode");
    const agents = await runtime.agents();
    assert.equal(agents[1]?.mode, "subagent");
    assert.equal(agents[2]?.mode, "auto");
    const caps = await runtime.capabilities();
    assert.equal(caps.streaming, true);
    assert.equal(caps.questions, true);
    assert.deepEqual(await runtime.sessions(), []);
    assert.deepEqual(await runtime.history("ses_fake_1"), []);
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("placeholder titles are omitted so OpenCode can generate a semantic title", async () => {
  const fake = await startFake();
  const runtime = await createTestRuntime(fake.baseUrl);
  try {
    await runtime.ensureSession({
      sessionId: "77a19c0e-8ead-42f7-aa2c-eb31dcbbcf98",
      projectId: "p",
      cwd: "/tmp",
      title: "New session",
    });
    await runtime.ensureSession({
      sessionId: "custom",
      projectId: "p",
      cwd: "/tmp",
      title: "Release checklist",
    });
    await runtime.ensureSession({
      sessionId: "stale-placeholder",
      projectId: "p",
      cwd: "/tmp",
      title: "New session - 2026-08-26T05:00:55.897Z",
    });
    await runtime.ensureSession({
      sessionId: "multirun-placeholder",
      projectId: "p",
      cwd: "/tmp",
      title: "polyth multirun",
    });
    await runtime.ensureSession({
      sessionId: "oneshot-placeholder",
      projectId: "p",
      cwd: "/tmp",
      title: "polyth small-model task",
    });
    assert.deepEqual(
      fake.sessionCreateBodies,
      [{}, { title: "Release checklist" }, {}, {}, {}],
    );
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("translates chunks, tools, permission, question; turn started/stopped once", async () => {
  const fake = await startFake();
  const runtime = await createTestRuntime(fake.baseUrl);
  const events: Array<{ sessionId: string; ev: RuntimeEvent }> = [];
  runtime.onEvent((sessionId, ev) => events.push({ sessionId, ev }));
  try {
    await runtime.ensureSession({
      sessionId: "canon-1",
      projectId: "p",
      cwd: "/tmp",
      title: "t",
    });
    await waitUntil(() => fake.sseClients.length >= 1);
    await runtime.startTurn({ sessionId: "canon-1", text: "hi" });
    await waitUntil(() => events.some((e) => e.ev.type === "turn/stopped"));
    const types = events.map((e) => e.ev.type);
    assert.equal(types.filter((t) => t === "turn/started").length, 1);
    assert.equal(types.filter((t) => t === "turn/stopped").length, 1);
    const chunks = events.filter((e) => e.ev.type === "assistant/chunk");
    assert.deepEqual(
      chunks.map((e) => (e.ev as { text: string }).text),
      ["Hel", "lo"],
    );
    const msg = events.find((e) => e.ev.type === "assistant/message");
    assert.equal((msg?.ev as { text: string }).text, "Hello");
    const callIdx = types.indexOf("tool/call");
    const resultIdx = types.indexOf("tool/result");
    assert.ok(callIdx >= 0 && resultIdx > callIdx);
    const perm = events.find((e) => e.ev.type === "permission/requested")?.ev as {
      requestId: string;
      permission: string;
      patterns: string[];
      tool?: string;
    };
    assert.equal(perm.requestId, "per_abc");
    assert.equal(perm.permission, "bash");
    assert.deepEqual(perm.patterns, ["ls"]);
    assert.equal(perm.tool, "call_1");
    const q = events.find((e) => e.ev.type === "question/asked")?.ev as { requestId: string };
    assert.equal(q.requestId, "que_1");
    events.forEach((e) => assert.equal(e.sessionId, "canon-1"));
    await runtime.replyPermission("canon-1", "per_abc", "once");
    assert.deepEqual(fake.permissionReplies[0], { response: "once" });
    await runtime.replyQuestion("canon-1", "que_1", { answers: [["yes"]] });
    assert.deepEqual(fake.questionReplies[0], { answers: [["yes"]] });
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("confirmed abort accepts bare idle without assistant completion", async () => {
  const fake = await startFake();
  const runtime = await createTestRuntime(fake.baseUrl);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_sessionId, event) => events.push(event));
  try {
    await runtime.ensureSession({
      sessionId: "abort-before-completion",
      projectId: "p",
      cwd: "/tmp",
      title: "t",
    });
    await waitUntil(() => fake.sseClients.length >= 1);
    await runtime.startTurn({ sessionId: "abort-before-completion", text: "stop me" });
    await runtime.abort("abort-before-completion");
    fake.replay({
      id: "evt_abort_idle",
      type: "session.idle",
      properties: { sessionID: "ses_fake_1" },
    });

    await waitUntil(() => events.some((event) => event.type === "turn/stopped"));
    const stopped = events.filter((event) => event.type === "turn/stopped");
    assert.equal(fake.aborts, 1);
    assert.deepEqual(stopped, [{ type: "turn/stopped", reason: "aborted" }]);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      events.filter((event) => event.type === "turn/stopped").length,
      1,
      "the delayed completion/idle cannot stop the aborted turn twice",
    );
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("idle before assistant completion still closes the admitted turn", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");

  assert.equal(
    claimTerminalStateEvidence({
      type: "session.idle",
      properties: { sessionID: "ses-1" },
    }, state),
    undefined,
  );

  translateOcEvent({
    type: "message.updated",
    properties: {
      sessionID: "ses-1",
      info: { id: "msg-1", role: "assistant", time: { completed: 2 } },
    },
  }, state);
  assert.deepEqual(
    claimTerminalStateEvidence({ type: "message.updated", properties: {} }, state),
    { state: "idle" },
  );
});

test("SSE reconnect dedups by event id", async () => {
  const fake = await startFake();
  const runtime = await createTestRuntime(fake.baseUrl);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_s, ev) => events.push(ev));
  try {
    await runtime.ensureSession({ sessionId: "c2", projectId: "p", cwd: "/tmp" });
    await waitUntil(() => fake.sseClients.length >= 1);
    const dup: ScriptedEvent = {
      id: "evt_dup",
      type: "permission.asked",
      properties: {
        id: "per_z",
        sessionID: "ses_fake_1",
        permission: "edit",
        patterns: ["a.ts"],
      },
    };
    fake.replay(dup);
    fake.replay(dup);
    await waitUntil(() => events.filter((e) => e.type === "permission/requested").length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(events.filter((e) => e.type === "permission/requested").length, 1);
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("flattenModels marks connected providers; empty connected[] means all connected", () => {
  const twoProviders: Parameters<typeof flattenModels>[0] = {
    all: [
      { id: "openai", models: { "gpt-x": { id: "gpt-x", name: "GPT X" } } },
      { id: "ollama", models: { llama: { id: "llama", name: "Llama" } } },
    ],
    connected: ["openai"],
  };
  const marked = flattenModels(twoProviders);
  assert.equal(marked.find((m) => m.providerID === "openai")?.connected, true);
  assert.equal(marked.find((m) => m.providerID === "ollama")?.connected, false);

  // No signal (empty or missing connected[]) → nothing gets hidden.
  for (const connected of [[], undefined]) {
    const all = flattenModels({ ...twoProviders, connected });
    assert.ok(all.every((m) => m.connected === true), "all connected when signal is absent");
  }
});

test("flattenModels preserves reported input/output modalities including empty reports", () => {
  const models = flattenModels({
    all: [{
      id: "mixed",
      models: {
        chat: {
          id: "chat",
          name: "Chat",
          capabilities: {
            attachment: true,
            toolcall: true,
            input: { text: true, image: true, audio: false },
            output: { text: true, image: false },
          },
        },
        embed: {
          id: "embed",
          name: "Embed",
          capabilities: { input: { text: true }, output: { text: false } },
        },
      },
    }],
  });
  assert.deepEqual(models.find((model) => model.modelID === "chat")?.capabilities, [
    "attachment", "toolcall", "input:image", "input:text", "output:text",
  ]);
  assert.deepEqual(models.find((model) => model.modelID === "embed")?.capabilities, [
    "input:text", "output:none",
  ]);
});

test("startTurn maps attachments to file parts; url attachments stay text (F2)", async () => {
  const fake = await startFake();
  const runtime = await createTestRuntime(fake.baseUrl, "/workspace/demo");
  try {
    await runtime.ensureSession({ sessionId: "canon-att", projectId: "p", cwd: "/workspace/demo", title: "t" });
    await runtime.startTurn({
      sessionId: "canon-att",
      text: "review these",
      attachments: [
        { id: "a1", name: "notes.md", mime: "text/plain", size: 10, kind: "file", path: "docs/notes.md" },
        { id: "a2", name: "pic.png", mime: "image/png", size: 99, kind: "image", path: "img/pic.png" },
        { id: "a3", name: "i.ts (3-9)", mime: "text/plain", size: 5, kind: "range", path: "src/i.ts", range: [3, 9] },
        { id: "a4", name: "PR #4", mime: "text/uri-list", size: 0, kind: "url", url: "https://github.com/o/r/pull/4" },
        { id: "a5", name: "escape", mime: "text/plain", size: 1, kind: "file", path: "../../etc/passwd" },
      ],
    });
    await waitUntil(() => fake.postedBodies.length >= 1);
    const body = fake.postedBodies[0]!;
    const parts = body.parts as Array<Record<string, unknown>>;
    assert.deepEqual(parts[0], { type: "text", text: "review these" });
    assert.deepEqual(parts[1], { type: "file", mime: "text/plain", filename: "notes.md", url: "file:///workspace/demo/docs/notes.md" });
    assert.deepEqual(parts[2], { type: "file", mime: "image/png", filename: "pic.png", url: "file:///workspace/demo/img/pic.png" });
    assert.deepEqual(parts[3], { type: "file", mime: "text/plain", filename: "i.ts (3-9)", url: "file:///workspace/demo/src/i.ts?start=3&end=9" });
    // URL attachment: a text part carrying the link — never a fetchable file part
    assert.deepEqual(parts[4], { type: "text", text: "[Attached link: PR #4] https://github.com/o/r/pull/4" });
    // path escaping the session cwd is dropped entirely
    assert.equal(parts.length, 5);
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("startTurn forwards a selected thinking variant", async () => {
  const fake = await startFake();
  const runtime = await createTestRuntime(fake.baseUrl, "/workspace/demo");
  try {
    await runtime.ensureSession({ sessionId: "canon-think", projectId: "p", cwd: "/workspace/demo", title: "t" });
    await runtime.startTurn({
      sessionId: "canon-think",
      text: "think",
      model: { providerID: "openai", modelID: "gpt-test", variant: "high" },
    });
    await waitUntil(() => fake.postedBodies.length >= 1);
    assert.equal(fake.postedBodies[0]?.variant, "high");
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

// ---------------------------------------------------------------- UX-MSG-ACTIONS: native branch

interface FakeMessage {
  info: { id: string; role: string };
  parts: Array<{ type: string; text?: string }>;
}

const fakeMsg = (id: string, role: string, text: string): FakeMessage => ({
  info: { id, role },
  parts: [{ type: "text", text }],
});

/** Minimal fork-capable OpenCode fake: message lists per session, native
 *  /fork copying strictly BEFORE messageID, DELETE, and prompt capture. */
const startForkFake = async () => {
  const sessions = new Map<string, FakeMessage[]>();
  let forkSeq = 0;
  const forkBodies: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const promptPaths: string[] = [];
  let createdSeq = 0;
  const state = { breakFork: false };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && path === "/global/health") {
      return json(200, { healthy: true, version: "fake" });
    }
    if (req.method === "GET" && path === "/doc") {
      return json(200, {
        paths: {
          "/session/{sessionID}/prompt_async": { post: {} },
          "/session/{sessionID}/message": { post: {} },
        },
      });
    }
    const readBody = (cb: (body: Record<string, unknown>) => void) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => cb(JSON.parse(raw || "{}") as Record<string, unknown>));
    };
    if (req.method === "GET" && path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"type\":\"server.connected\",\"properties\":{}}\n\n");
      return;
    }
    const messages = path.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && messages) return json(200, sessions.get(messages[1]!) ?? []);
    if (req.method === "POST" && messages) {
      promptPaths.push(path);
      return json(200, { ok: true });
    }
    const prompt = path.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (req.method === "POST" && prompt) {
      promptPaths.push(path);
      return json(200, { ok: true });
    }
    const fork = path.match(/^\/session\/([^/]+)\/fork$/);
    if (req.method === "POST" && fork) {
      const src = sessions.get(fork[1]!) ?? [];
      return readBody((body) => {
        forkBodies.push(body);
        const boundary = typeof body.messageID === "string" ? body.messageID : undefined;
        // OpenCode semantics: copy messages strictly BEFORE messageID
        let copied = boundary ? src.filter((m) => m.info.id < boundary) : [...src];
        if (state.breakFork) copied = copied.slice(0, -1);
        forkSeq += 1;
        const id = `ses_fork_${forkSeq}`;
        sessions.set(id, copied);
        json(200, { id, title: "fork" });
      });
    }
    if (req.method === "POST" && path === "/session") {
      createdSeq += 1;
      const id = `ses_new_${createdSeq}`;
      sessions.set(id, []);
      return json(200, { id, title: "t" });
    }
    const del = path.match(/^\/session\/([^/]+)$/);
    if (req.method === "DELETE" && del) {
      deleted.push(del[1]!);
      sessions.delete(del[1]!);
      return json(200, true);
    }
    json(404, { error: path });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    server, sessions, forkBodies, deleted, promptPaths, state,
  };
};

const userMsg = (text: string): ModelMessage => ({ role: "user", parts: [{ type: "text", text }] });
const asstMsg = (text: string): ModelMessage => ({ role: "assistant", parts: [{ type: "text", text }] });

test("branchSession forks strictly before the first excluded message and verifies the child", async () => {
  const fake = await startForkFake();
  const runtime = await createTestRuntime(fake.baseUrl);
  try {
    fake.sessions.set("ses_src", [
      fakeMsg("msg_1", "user", "same"),
      fakeMsg("msg_2", "assistant", "one"),
      fakeMsg("msg_3", "user", "same"),
      fakeMsg("msg_4", "assistant", "two"),
    ]);
    await runtime.ensureSession({ sessionId: "canon-src", projectId: "p", cwd: "/tmp", backendSessionId: "ses_src" });

    const childId = await runtime.branchSession!({
      sourceSessionId: "canon-src",
      target: { projectId: "p", sessionId: "canon-child", cwd: "/tmp", title: "T (fork)" },
      history: [userMsg("same"), asstMsg("one")],
    });
    // boundary is the first EXCLUDED backend message, not the predecessor
    assert.deepEqual(fake.forkBodies[0], { messageID: "msg_3" });
    assert.equal(childId, "ses_fork_1");
    // the child mapping is live: a turn for the fork canonical posts to it
    await runtime.startTurn({ sessionId: "canon-child", text: "next" });
    assert.ok(fake.promptPaths.some((p) => p.includes("ses_fork_1")));

    // duplicate prompt text selects the LATER requested predecessor
    await runtime.branchSession!({
      sourceSessionId: "canon-src",
      target: { projectId: "p", sessionId: "canon-child-2", cwd: "/tmp", title: "T (fork)" },
      history: [userMsg("same"), asstMsg("one"), userMsg("same")],
    });
    assert.deepEqual(fake.forkBodies[1], { messageID: "msg_4" });

    // full effective history: no messageID at all
    await runtime.branchSession!({
      sourceSessionId: "canon-src",
      target: { projectId: "p", sessionId: "canon-child-3", cwd: "/tmp", title: "T (fork)" },
      history: [userMsg("same"), asstMsg("one"), userMsg("same"), asstMsg("two")],
    });
    assert.deepEqual(fake.forkBodies[2], {});

    // empty prefix: a fresh session, no fork call
    const freshId = await runtime.branchSession!({
      sourceSessionId: "canon-src",
      target: { projectId: "p", sessionId: "canon-child-4", cwd: "/tmp", title: "T (fork)" },
      history: [],
    });
    assert.equal(freshId, "ses_new_1");
    assert.equal(fake.forkBodies.length, 3);
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("branchSession history mismatches keep mappings untouched", async () => {
  const fake = await startForkFake();
  const runtime = await createTestRuntime(fake.baseUrl);
  try {
    fake.sessions.set("ses_src", [
      fakeMsg("msg_1", "user", "hello"),
      fakeMsg("msg_2", "assistant", "world"),
    ]);
    await runtime.ensureSession({ sessionId: "canon-src", projectId: "p", cwd: "/tmp", backendSessionId: "ses_src" });

    // prefix that is not present in the backend at all
    await assert.rejects(
      () => runtime.branchSession!({
        sourceSessionId: "canon-src",
        target: { projectId: "p", sessionId: "canon-x", cwd: "/tmp" },
        history: [userMsg("different")],
      }),
      (err: Error & { code?: string }) => err.code === "history-mismatch",
    );
    assert.equal(fake.forkBodies.length, 0, "no fork attempted for an absent prefix");

    // Fork succeeds but the read-back child differs. The lifecycle facade
    // must not issue an untracked best-effort delete; canonical orchestration
    // owns any durable cleanup operation.
    fake.state.breakFork = true;
    await assert.rejects(
      () => runtime.branchSession!({
        sourceSessionId: "canon-src",
        target: { projectId: "p", sessionId: "canon-src", cwd: "/tmp" }, // revert-style: same canonical id
        history: [userMsg("hello")],
      }),
      (err: Error & { code?: string }) => err.code === "outcome-unknown",
    );
    assert.equal(fake.deleted.length, 0);
    // mapping was NOT swapped: the canonical session still posts to ses_src
    await runtime.startTurn({ sessionId: "canon-src", text: "still original" });
    assert.ok(fake.promptPaths.some((p) => p.includes("ses_src")));
    assert.ok(!fake.promptPaths.some((p) => p.includes("ses_fork_1")));

    // discardSession is best-effort and clears mappings by backend id
    await runtime.discardSession!("ses_missing");
    assert.ok(fake.deleted.includes("ses_missing"));
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

// ---------------------------------------------------------------- UX-MSG-ACTIONS: part classification

test("untyped deltas buffer invisibly until part.type resolves them to reasoning", () => {
  const st = createTranslateState();
  // missing-field delta: nothing may be displayed yet
  const out1 = translateOcEvent({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m_a", partID: "prt_r", delta: "thinking…" },
  }, st);
  assert.deepEqual(out1, []);
  // classification arrives: buffered bytes resolve to exactly one channel
  const out2 = translateOcEvent({
    type: "message.part.updated",
    properties: { sessionID: "s", part: { id: "prt_r", type: "reasoning", messageID: "m_a", sessionID: "s" } },
  }, st);
  assert.deepEqual(out2, [{ type: "assistant/reasoning-chunk", partId: "prt_r", text: "thinking…" }]);
  // later typed reasoning delta appends normally
  const out3 = translateOcEvent({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m_a", partID: "prt_r", field: "reasoning", delta: " more" },
  }, st);
  assert.deepEqual(out3, [{ type: "assistant/reasoning-chunk", partId: "prt_r", text: " more" }]);
  // a later update claiming to be text cannot migrate displayed reasoning
  const out4 = translateOcEvent({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m_a", partID: "prt_r", field: "text", delta: "!" },
  }, st);
  assert.deepEqual(out4, [{ type: "assistant/reasoning-chunk", partId: "prt_r", text: "!" }]);
  assert.equal(st.partText.size, 0, "reasoning never enters the text-finalization map");
  // finalization emits ONE reasoning-only record with empty text
  const out5 = translateOcEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "s",
      part: { id: "prt_r", type: "reasoning", text: "thinking… more!", messageID: "m_a", sessionID: "s", time: { start: 1, end: 2 } },
    },
  }, st);
  assert.deepEqual(out5, [{ type: "assistant/message", partId: "prt_r", text: "", reasoning: "thinking… more!" }]);
  // idle flush adds no duplicate answer bubble
  assert.deepEqual(flushAssistantOnIdle(st), []);
});

test("a text part followed by stop yields exactly one finalized answer", () => {
  const st = createTranslateState();
  translateOcEvent({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m_a", partID: "prt_t", field: "text", delta: "Hel" },
  }, st);
  translateOcEvent({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m_a", partID: "prt_t", field: "text", delta: "lo" },
  }, st);
  const final = translateOcEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "s",
      part: { id: "prt_t", type: "text", text: "Hello", messageID: "m_a", sessionID: "s", time: { start: 1, end: 2 } },
    },
  }, st);
  assert.deepEqual(final.map((e) => e.type), ["assistant/message"]);
  assert.equal((final[0] as { text: string }).text, "Hello");
  assert.deepEqual(flushAssistantOnIdle(st), [], "no duplicate on idle");
  // an unclassified part with buffered bytes is never flushed as text
  translateOcEvent({
    type: "message.part.delta",
    properties: { sessionID: "s", messageID: "m_a", partID: "prt_unknown", delta: "???" },
  }, st);
  assert.deepEqual(flushAssistantOnIdle(st), []);
});

test("session.updated exposes OpenCode's generated title and ignores malformed updates", () => {
  const state = createTranslateState();
  assert.deepEqual(
    translateOcEvent({
      type: "session.updated",
      properties: {
        info: {
          id: "ses_1",
          title: "  Why WebSocket reconnect test misses events  ",
        },
      },
    }, state),
    [{ type: "session/title-generated", title: "Why WebSocket reconnect test misses events" }],
  );
  assert.deepEqual(
    translateOcEvent({
      type: "session.updated",
      properties: { info: { id: "ses_1", title: "   " } },
    }, state),
    [],
  );
  // OpenCode's placeholder burst is not a user-meaningful title.
  assert.deepEqual(
    translateOcEvent({
      type: "session.updated",
      properties: { info: { id: "ses_1", title: "New session - 2026-08-26T05:00:55.897Z" } },
    }, state),
    [],
  );
});

test("title snapshots without upstream revisions remain independently ingestible", () => {
  const observed = {
    authorityId: "authority-a", generation: 1, location: { directory: "/project" },
    backendSessionId: "ses_1", reconciliationOrdinal: 1,
  };
  const normalize = (title: string) => normalizeOcObservation({
    data: { type: "session.updated", properties: { info: { id: "ses_1", title } } },
    channel: "sse", observed, current: observed,
  });

  const placeholder = normalize("New session");
  const generated = normalize("Stabilize reconnect behavior");
  assert.equal(placeholder.kind, "accepted");
  assert.equal(generated.kind, "accepted");
  if (placeholder.kind !== "accepted" || generated.kind !== "accepted") return;
  assert.notEqual(placeholder.observation.identity.revision, generated.observation.identity.revision);
  assert.deepEqual(generated.observation.events, [{ type: "session/title-generated", title: "Stabilize reconnect behavior" }]);
});

test("session.updated revisions ignore the embedded OpenCode version so titles are not deduplicated", () => {
  // Real V2 session snapshots carry `info.version` (the OpenCode engine
  // version, constant across every update). Using it as the observation
  // revision folds every title change into the first placeholder snapshot,
  // so the semantic title is dropped as a duplicate by the store.
  const observed = {
    authorityId: "authority-a", generation: 1, location: { directory: "/project" },
    backendSessionId: "ses_1", reconciliationOrdinal: 1,
  };
  const normalize = (title: string) => normalizeOcObservation({
    data: {
      type: "session.updated",
      properties: {
        info: { id: "ses_1", title, version: "1.18.18", time: { updated: 1788191131386 } },
      },
    },
    channel: "sse", observed, current: observed,
  });

  const placeholder = normalize("New session - 2026-08-31T15:45:28.650Z");
  const generated = normalize("Greeting");
  assert.equal(placeholder.kind, "accepted");
  assert.equal(generated.kind, "accepted");
  if (placeholder.kind !== "accepted" || generated.kind !== "accepted") return;
  assert.notEqual(
    placeholder.observation.identity.revision,
    generated.observation.identity.revision,
    "the semantic title observation must not deduplicate against the placeholder snapshot",
  );
  assert.equal(placeholder.observation.identity.revision, "title:New session - 2026-08-31T15:45:28.650Z");
  assert.equal(generated.observation.identity.revision, "title:Greeting");
  assert.deepEqual(generated.observation.events, [{ type: "session/title-generated", title: "Greeting" }]);
});

test("session compaction and compaction parts translate to canonical runtime events", () => {
  const st = createTranslateState();
  assert.deepEqual(
    translateOcEvent({
      id: "evt_compacted",
      type: "session.compacted",
      properties: { sessionID: "ses_1" },
    }, st),
    [{ type: "session/compacted", backendEventId: "evt_compacted" }],
  );
  const part = {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_compaction",
        type: "compaction",
        messageID: "msg_summary",
        sessionID: "ses_1",
        auto: true,
      },
    },
  };
  assert.deepEqual(translateOcEvent(part, st), [{
    type: "compaction/part-recorded",
    partId: "prt_compaction",
    messageId: "msg_summary",
    auto: true,
  }]);
  assert.deepEqual(translateOcEvent(part, st), [], "repeated part snapshots are deduplicated");
});

test("real opencode provider list", { skip: process.env.POLYTH_REAL_OPENCODE !== "1" }, async () => {
  const { createOpenCodeRuntime } = await import("../src/index.ts");
  const runtime = await createOpenCodeRuntime({
    projectId: "real-opencode-probe",
    cwd: "/tmp/oc-probe",
    runtimeDir: "/tmp/polyth-real-opencode-probe",
    port: 4579,
  });
  try {
    const models = await runtime.models();
    assert.ok(Array.isArray(models));
  } finally {
    await runtime.dispose();
  }
});
