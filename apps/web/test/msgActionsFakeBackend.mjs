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
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const hostname = argOf("--hostname", "127.0.0.1");
const port = Number(argOf("--port", "0"));

// ---- seeded state -----------------------------------------------------------

/** id → { id, title, parentID?, forkBehavior?, messages: [wire message] } */
const sessions = new Map();
const state = { prompts: [], forks: [], deleted: [] };
let counter = 0;

const wireMessage = (sessionID, role, text, id) => ({
  info: { id, role, sessionID, time: { created: Date.now() } },
  parts: [{ id: `prt_${id}`, type: "text", text }],
});

const seedPath = process.env.MSGACT_OC_SEED;
if (seedPath) {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
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
  }, 40);
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
    if (method === "GET" && path === "/provider") {
      return json(res, 200, {
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
      return json(res, 200, [{ name: "build", description: "Synthetic build agent", mode: "primary" }]);
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
      sessions.set(id, { id, title: String(body.title ?? id), messages: [] });
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
