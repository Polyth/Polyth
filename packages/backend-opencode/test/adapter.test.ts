import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import {
  createOpenCodeClient,
  createOpenCodeRuntimeWithClient,
} from "../src/index.ts";

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
    properties: { sessionID },
  },
];

const sseFrame = (ev: ScriptedEvent) =>
  `data: ${JSON.stringify(ev)}\n\n`;

const startFake = async () => {
  let sessionSeq = 0;
  const sseClients: http.ServerResponse[] = [];
  let posted = false;
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
    if (req.method === "GET" && path === "/provider") return json(200, providerBody);
    if (req.method === "GET" && path === "/agent") return json(200, agentsBody);
    if (req.method === "POST" && path === "/session") {
      sessionSeq += 1;
      return json(200, { id: `ses_fake_${sessionSeq}`, title: "t", directory: "/tmp" });
    }
    if (req.method === "GET" && path === "/session") return json(200, []);
    const msg = path.match(/^\/session\/([^/]+)\/(message|prompt_async)$/);
    if (req.method === "POST" && msg) {
      const sessionID = msg[1]!;
      posted = true;
      json(200, { ok: true });
      setTimeout(() => {
        for (const ev of scriptedSequence(sessionID)) {
          const frame = sseFrame(ev);
          for (const c of sseClients) c.write(frame);
        }
      }, 40);
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

test("models/agents flatten from verified /provider and /agent shapes", async () => {
  const fake = await startFake();
  const client = createOpenCodeClient(fake.baseUrl);
  const runtime = createOpenCodeRuntimeWithClient(client, {});
  try {
    const models = await runtime.models();
    assert.equal(models[0]?.providerID, "opencode");
    assert.equal(models[0]?.modelID, "big-pickle");
    assert.equal(models[0]?.context, 128000);
    assert.deepEqual(models[0]?.cost, { input: 0, output: 0 });
    const agents = await runtime.agents();
    assert.equal(agents[1]?.mode, "subagent");
    const caps = await runtime.capabilities();
    assert.equal(caps.streaming, true);
    assert.equal(caps.questions, true);
  } finally {
    await runtime.dispose();
    fake.server.close();
  }
});

test("translates chunks, tools, permission, question; turn started/stopped once", async () => {
  const fake = await startFake();
  const client = createOpenCodeClient(fake.baseUrl);
  const runtime = createOpenCodeRuntimeWithClient(client, {});
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

test("SSE reconnect dedups by event id", async () => {
  const fake = await startFake();
  const client = createOpenCodeClient(fake.baseUrl);
  const runtime = createOpenCodeRuntimeWithClient(client, {});
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

test("real opencode provider list", { skip: process.env.POLYTH_REAL_OPENCODE !== "1" }, async () => {
  const { createOpenCodeRuntime } = await import("../src/index.ts");
  const runtime = await createOpenCodeRuntime({ cwd: "/tmp/oc-probe", port: 4579 });
  try {
    const models = await runtime.models();
    assert.ok(Array.isArray(models));
  } finally {
    await runtime.dispose();
  }
});
