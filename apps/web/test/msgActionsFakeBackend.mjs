// UX-MSG-ACTIONS live-gate stand-in for the model runtime process. The Polyth
// server spawns it exactly like the real CLI (`<bin> serve --hostname H
// --port P`); it answers the same REST surface and streams the same SSE
// grammar, entirely synthetic and in-memory. Failure injection is seeded per
// session (`forkBehavior`), never ambient, so every live-gate scenario is
// deterministic. Only the isolated fixture ever runs this file.
//
// env:
//   MSGACT_OC_SEED   JSON file: { sessions: [{ id, title, forkBehavior?,
//                    messages: [{ id, role, text }] }] }
//   MSGACT_OC_STATE  where to persist observable state after each mutation
//                    (the live test reads this FILE — it never talks to this
//                    process directly)
//   MSGACT_TURN_DELAY_MS delay for ordinary synthetic turns (default 40)
//   MSGACT_OC_CATALOG JSON file overriding the served model/agent catalog:
//                    { providers: <GET /provider body>, agents: <GET /agent
//                    body> } — used by picker QA fixtures that need several
//                    providers, variants, and agents.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.18.18-msgact-fake\n");
  process.exit(0);
}
if (args[0] === "db" && args[1] === "path") {
  process.stdout.write(`${process.env.OPENCODE_DB ?? ""}\n`);
  process.exit(process.env.OPENCODE_DB ? 0 : 2);
}
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const hostname = argOf("--hostname", "127.0.0.1");
const port = Number(argOf("--port", "0"));
const turnDelayMs = Number(process.env.MSGACT_TURN_DELAY_MS) || 40;
const streamStepMs = Number(process.env.MSGACT_STREAM_STEP_MS) || 150;

// ---- seeded state -----------------------------------------------------------

/** id → { id, title, parentID?, forkBehavior?, messages: [wire message] } */
const sessions = new Map();
const createdTurnBehaviors = new Map();
const state = { prompts: [], forks: [], deleted: [] };
let counter = 0;

const wireMessage = (sessionID, role, text, id) => ({
  info: { id, role, sessionID, time: { created: Date.now() } },
  parts: [{ id: `prt_${id}`, type: "text", text }],
});

const catalog = process.env.MSGACT_OC_CATALOG
  ? JSON.parse(readFileSync(process.env.MSGACT_OC_CATALOG, "utf8"))
  : null;

const seedPath = process.env.MSGACT_OC_SEED;
if (seedPath) {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  for (const [title, behavior] of Object.entries(seed.createdTurnBehaviors ?? {})) {
    if (typeof behavior === "string") createdTurnBehaviors.set(title, behavior);
  }
  for (const s of seed.sessions ?? []) {
    sessions.set(s.id, {
      id: s.id,
      title: s.title ?? s.id,
      forkBehavior: s.forkBehavior,
      turnBehavior: s.turnBehavior,
      messages: (s.messages ?? []).map((m) => wireMessage(s.id, m.role, m.text, m.id)),
    });
  }
}

const persistState = () => {
  const file = process.env.MSGACT_OC_STATE;
  if (!file) return;
  const snapshot = {
    ...state,
    sessions: Object.fromEntries(
      [...sessions.values()].map((s) => [
        s.id,
        s.messages.map((m) => ({
          id: m.info.id,
          role: m.info.role,
          text: m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n"),
        })),
      ]),
    ),
  };
  try {
    writeFileSync(file, JSON.stringify(snapshot, null, 2));
  } catch {
    /* observability only */
  }
};

// ---- SSE --------------------------------------------------------------------

const sseClients = new Set();
const emit = (type, properties) => {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) res.write(frame);
};

// ---- synthetic turn ---------------------------------------------------------

const runTurn = (sess, promptText) => {
  // "hang": the turn never completes — the live gate uses this to hold a
  // session in a truthful active-turn + queued-delivery state.
  if (sess.turnBehavior === "hang") return;
  // "stream": several growing full-text snapshots before finalization, so the
  // timeline layout gate can observe tail-follow and reader-held positions
  // while scrollHeight actually grows (UX-TIMELINE-LAYOUT-01).
  if (sess.turnBehavior === "stream") {
    const n = ++counter;
    const asId = `as_${n}`;
    const partId = `prt_as_${n}`;
    const started = Date.now();
    const para = (i) =>
      `Streamed paragraph ${i} for "${promptText.slice(0, 40)}": the synthetic ` +
      "stream appends several rendered lines so follow, hold, and the latest " +
      "reveal are observable while the transcript grows.\n\n";
    const total = 8;
    let text = "";
    for (let i = 1; i <= total; i++) {
      setTimeout(() => {
        text += para(i);
        const done = i === total;
        emit("message.part.updated", {
          part: {
            id: partId,
            messageID: asId,
            sessionID: sess.id,
            type: "text",
            text,
            revision: i,
            time: done ? { start: started, end: Date.now() } : { start: started },
          },
        });
        if (done) {
          emit("message.updated", {
            info: {
              id: asId,
              sessionID: sess.id,
              role: "assistant",
              time: { completed: Date.now() },
              tokens: { input: 64, output: 128 },
              cost: 0.005,
              providerID: "synthetic",
              modelID: "fable-mini",
            },
          });
          sess.messages.push(wireMessage(sess.id, "assistant", text, asId));
          persistState();
          emit("session.idle", { sessionID: sess.id });
        }
      }, streamStepMs * i);
    }
    return;
  }
  // "work": a full synthetic agent turn — streaming reasoning snapshots, a
  // tool lifecycle (pending → running → completed), then streamed answer text.
  // P2-W2 uses this to QA live thinking, tool appearance, and tail-follow.
  if (sess.turnBehavior === "work") {
    const n = ++counter;
    const asId = `as_${n}`;
    const started = Date.now();
    const at = (ms, fn) => setTimeout(fn, ms);
    const reasonId = `prt_rsn_${n}`;
    const thought = (i) =>
      `Considering step ${i} for "${promptText.slice(0, 32)}": the live tail preview should always show this newest line.\n\n`;
    let reasoning = "";
    for (let i = 1; i <= 5; i++) {
      at(200 * i, () => {
        reasoning += thought(i);
        emit("message.part.updated", {
          part: {
            id: reasonId, messageID: asId, sessionID: sess.id,
            type: "reasoning", text: reasoning, revision: i,
            time: i === 5 ? { start: started, end: Date.now() } : { start: started },
          },
        });
      });
    }
    const callID = `call_w2_${n}`;
    const toolPart = (status, extra = {}) => ({
      part: {
        id: `prt_tool_${n}`, messageID: asId, sessionID: sess.id,
        type: "tool", callID, tool: "bash",
        state: { status, input: { command: "npm test", description: "Synthetic verification run" }, ...extra },
      },
    });
    at(1300, () => emit("message.part.updated", toolPart("pending")));
    at(1600, () => emit("message.part.updated", toolPart("running")));
    at(2400, () => emit("message.part.updated", toolPart("completed", { output: "84 tests passed\n0 failures", title: "npm test" })));
    const textId = `prt_txt_${n}`;
    let text = "";
    const para = (i) => `Streamed answer paragraph ${i}: the synthetic turn covered thinking, one tool lifecycle, and this growing reply.\n\n`;
    for (let i = 1; i <= 4; i++) {
      at(2700 + 250 * i, () => {
        text += para(i);
        const done = i === 4;
        emit("message.part.updated", {
          part: {
            id: textId, messageID: asId, sessionID: sess.id, type: "text", text, revision: i,
            time: done ? { start: started, end: Date.now() } : { start: started },
          },
        });
        if (done) {
          emit("message.updated", {
            info: {
              id: asId, sessionID: sess.id, role: "assistant",
              time: { completed: Date.now() },
              tokens: { input: 96, output: 210 }, cost: 0.008,
              providerID: "synthetic", modelID: "fable-mini",
            },
          });
          sess.messages.push(wireMessage(sess.id, "assistant", text, asId));
          persistState();
          emit("session.idle", { sessionID: sess.id });
        }
      });
    }
    return;
  }
  const n = ++counter;
  const asId = `as_${n}`;
  const partId = `prt_as_${n}`;
  const replyText = `Synthetic reply ${n}: acknowledged "${promptText.slice(0, 60)}".`;
  setTimeout(() => {
    const now = Date.now();
    emit("message.part.updated", {
      part: {
        id: partId,
        messageID: asId,
        sessionID: sess.id,
        type: "text",
        text: replyText,
        time: { start: now, end: now },
      },
    });
    emit("message.updated", {
      info: {
        id: asId,
        sessionID: sess.id,
        role: "assistant",
        time: { completed: now },
        tokens: { input: 42, output: 17 },
        cost: 0.0042,
        providerID: "synthetic",
        modelID: "fable-mini",
      },
    });
    sess.messages.push(wireMessage(sess.id, "assistant", replyText, asId));
    persistState();
    emit("session.idle", { sessionID: sess.id });
  }, turnDelayMs);
};

// ---- HTTP -------------------------------------------------------------------

const json = (res, status, body) => {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(raw);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
  });

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${hostname}:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }
    if (method === "GET" && (path === "/global/health" || path === "/api/health")) {
      return json(res, 200, { healthy: true, version: "1.18.18-msgact-fake" });
    }
    if (method === "GET" && path === "/doc") {
      return json(res, 200, {
        openapi: "3.1.0",
        paths: {
          "/session/{sessionID}/prompt_async": { post: {} },
          "/session/{sessionID}/message": { post: {} },
        },
      });
    }
    if (method === "GET" && path === "/provider") {
      return json(res, 200, catalog?.providers ?? {
        all: [{
          id: "synthetic",
          name: "Synthetic",
          models: {
            "fable-mini": {
              id: "fable-mini", name: "Fable Mini",
              limit: { context: 128_000 }, cost: { input: 0, output: 0 },
            },
          },
        }],
        connected: ["synthetic"],
      });
    }
    if (method === "GET" && path === "/config/providers") {
      return json(res, 200, { providers: [], default: {} });
    }
    if (method === "GET" && path === "/agent") {
      return json(res, 200, catalog?.agents
        ?? [{ name: "build", description: "Synthetic build agent", mode: "primary" }]);
    }
    if (method === "GET" && path === "/session") {
      return json(res, 200, [...sessions.values()].map((s) => ({
        id: s.id, title: s.title,
        ...(s.parentID ? { parentID: s.parentID } : {}),
        time: { created: Date.now() - 60_000, updated: Date.now() },
      })));
    }
    if (method === "POST" && path === "/session") {
      const body = await readBody(req);
      const id = `oc_new_${++counter}`;
      const title = String(body.title ?? id);
      sessions.set(id, {
        id,
        title,
        turnBehavior: createdTurnBehaviors.get(title),
        messages: [],
      });
      persistState();
      return json(res, 200, { id });
    }

    const m = path.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (m) {
      const sess = sessions.get(m[1]);
      const rest = m[2] ?? "";
      if (method === "DELETE" && rest === "") {
        sessions.delete(m[1]);
        state.deleted.push(m[1]);
        persistState();
        return json(res, 200, {});
      }
      if (!sess) return json(res, 404, { message: `no session ${m[1]}` });
      if (method === "GET" && rest === "/message") {
        return json(res, 200, sess.messages);
      }
      if (method === "POST" && rest === "/fork") {
        const body = await readBody(req);
        if (sess.forkBehavior === "fail") {
          return json(res, 500, { message: "synthetic backend fork failure" });
        }
        const boundary = typeof body.messageID === "string"
          ? sess.messages.findIndex((msg) => msg.info.id === body.messageID)
          : -1;
        const copied = boundary >= 0 ? sess.messages.slice(0, boundary) : [...sess.messages];
        const id = `oc_child_${++counter}`;
        const child = {
          id,
          title: `${sess.title} (fork)`,
          parentID: sess.id,
          // Deep copy that preserves ids/text but re-homes sessionID.
          messages: copied.map((msg) => ({
            info: { ...msg.info, sessionID: id },
            parts: msg.parts.map((p) => ({ ...p })),
          })),
        };
        if (sess.forkBehavior === "mismatch") {
          // Corrupt the copy: verification in the adapter must fail, delete
          // the orphan, and leave the source untouched.
          child.messages.push(wireMessage(id, "assistant", "SYNTHETIC-MISMATCH-EXTRA", `as_bogus_${counter}`));
        }
        sessions.set(id, child);
        state.forks.push({ source: sess.id, messageID: body.messageID ?? null, child: id });
        persistState();
        return json(res, 200, { id });
      }
      if (method === "POST" && (rest === "/prompt_async" || rest === "/message")) {
        const body = await readBody(req);
        const text = Array.isArray(body.parts)
          ? body.parts.filter((p) => p?.type === "text").map((p) => String(p.text ?? "")).join("\n")
          : "";
        const usrId = `usr_${++counter}`;
        sess.messages.push(wireMessage(sess.id, "user", text, usrId));
        state.prompts.push({ sessionID: sess.id, text });
        persistState();
        json(res, 200, {});
        emit("message.updated", { info: { id: usrId, sessionID: sess.id, role: "user" } });
        runTurn(sess, text);
        return;
      }
      if (method === "POST" && rest === "/abort") {
        json(res, 200, {});
        emit("session.idle", { sessionID: sess.id });
        return;
      }
    }
    json(res, 404, { message: `no route ${method} ${path}` });
  })().catch((err) => {
    try { json(res, 500, { message: String(err) }); } catch { /* closed */ }
  });
});

server.listen(port, hostname, () => {
  persistState();
  // The adapter resolves the spawn on exactly this line.
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
