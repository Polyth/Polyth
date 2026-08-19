import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createOpenCodeClient } from "../src/client.ts";

const listen = async (server: http.Server): Promise<string> => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return `http://127.0.0.1:${addr.port}`;
};

test("streamEvents parses SSE frames served by a node:http server", async () => {
  let sawUrl = "";
  let sawHeader = "";
  let sse: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    sawUrl = req.url ?? "";
    sawHeader = String(req.headers["x-test"] ?? "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse = res;
    // one frame whole, one split mid-frame across writes, one with id + CRLF
    res.write(`data: {"n":1}\n\ndata: {"n`);
    setTimeout(() => {
      res.write(`":2}\n\nid: evt_9\r\ndata: {"n":3}\r\n\r\ndata: not-json\n\n`);
      res.end();
    }, 20);
  });
  const baseUrl = await listen(server);
  const client = createOpenCodeClient(baseUrl, {
    directory: "/tmp/proj",
    headers: { "x-test": "yes" },
  });
  const events: Array<{ id?: string; data: unknown }> = [];
  const ctrl = new AbortController();
  try {
    await client.streamEvents(ctrl.signal, (evt) => events.push(evt));
    assert.equal(sawUrl, `/event?directory=${encodeURIComponent("/tmp/proj")}`);
    assert.equal(sawHeader, "yes");
    assert.deepEqual(
      events.map((e) => e.data),
      [{ n: 1 }, { n: 2 }, { n: 3 }, "not-json"],
    );
    assert.equal(events[2]?.id, "evt_9");
  } finally {
    sse?.end();
    server.close();
  }
});

test("streamEvents abort destroys the request and rejects with AbortError", async () => {
  let closed = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: {"hello":true}\n\n`);
    req.on("close", () => {
      closed = true;
    });
  });
  const baseUrl = await listen(server);
  const client = createOpenCodeClient(baseUrl);
  const ctrl = new AbortController();
  const got: unknown[] = [];
  const stream = client.streamEvents(ctrl.signal, (evt) => got.push(evt.data));
  try {
    // wait for the first event so we know the stream is live before aborting
    const start = Date.now();
    while (got.length === 0) {
      if (Date.now() - start > 2000) throw new Error("no first event");
      await new Promise((r) => setTimeout(r, 10));
    }
    ctrl.abort();
    await assert.rejects(stream, (err: Error) => err.name === "AbortError");
    const t0 = Date.now();
    while (!closed) {
      if (Date.now() - t0 > 2000) throw new Error("server never saw close");
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(closed);
  } finally {
    server.close();
  }
});

test("streamEvents rejects on non-200 without hanging", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end("{}");
  });
  const baseUrl = await listen(server);
  const client = createOpenCodeClient(baseUrl);
  try {
    await assert.rejects(
      client.streamEvents(new AbortController().signal, () => {}),
      /GET \/event → 401/,
    );
  } finally {
    server.close();
  }
});

test("REST request retries transient socket failures then succeeds", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (hits <= 2) {
      // undici surfaces this as `TypeError: fetch failed` — must be retried
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hits }));
  });
  const baseUrl = await listen(server);
  const client = createOpenCodeClient(baseUrl);
  try {
    const body = await client.post<{ ok: boolean; hits: number }>("/session", { title: "t" });
    assert.deepEqual(body, { ok: true, hits: 3 });
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test("REST request gives up after 3 transient failures", async () => {
  let hits = 0;
  const server = http.createServer((req) => {
    hits += 1;
    req.socket.destroy();
  });
  const baseUrl = await listen(server);
  const client = createOpenCodeClient(baseUrl);
  try {
    await assert.rejects(client.get("/provider"), (err: Error) => /fetch failed/i.test(err.message));
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test("REST request does not retry HTTP error statuses", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  const baseUrl = await listen(server);
  const client = createOpenCodeClient(baseUrl);
  try {
    await assert.rejects(client.get("/provider"), /→ 500/);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
