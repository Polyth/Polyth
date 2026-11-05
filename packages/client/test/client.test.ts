import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createPolythClient, PolythApiError, signIn, type ClientEvent } from "../src/index.ts";

type Route = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function serve(t: test.TestContext, route: Route): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => route(req, res, Buffer.concat(chunks).toString()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const frame = (event: ClientEvent): string => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
const started = (seq: number): ClientEvent => ({ seq, time: seq, type: "turn.started", turnId: `t${seq}` });

test("a token never travels in clear to another machine", () => {
  for (const url of ["http://polyth.example", "http://192.168.1.20:4400", "ftp://polyth.example"]) {
    assert.throws(() => createPolythClient({ url, token: "pth_x" }), { code: "insecure-url" });
  }
  for (const url of ["https://polyth.example", "http://localhost:4400", "http://127.0.0.1:4400", "http://[::1]:4400"]) {
    assert.ok(createPolythClient({ url, token: "pth_x" }));
  }
});

test("requests carry the bearer token and the asked Space, and refusals become typed errors", async (t) => {
  const seen: IncomingMessage[] = [];
  const url = await serve(t, (req, res) => {
    seen.push(req);
    if (req.url === "/api/v1/projects") return json(res, 200, { projects: [{ id: "p", name: "P", path: "/x" }] });
    json(res, 403, { error: "forbidden", message: "not allowed" });
  });
  const client = createPolythClient({ url, token: "pth_secret", spaceId: "sp" });
  assert.deepEqual(await client.projects(), [{ id: "p", name: "P", path: "/x" }]);
  assert.equal(seen[0]!.headers.authorization, "Bearer pth_secret");
  assert.equal(seen[0]!.headers["x-polyth-space"], "sp");
  await assert.rejects(client.me(), (error: PolythApiError) => {
    assert.ok(error instanceof PolythApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "forbidden");
    assert.equal(error.message, "not allowed");
    return true;
  });
});

test("a send always has an operation id, and a lost one is reported for a safe retry", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  let drop = true;
  const url = await serve(t, (req, res, body) => {
    bodies.push(JSON.parse(body) as Record<string, unknown>);
    if (drop) {
      drop = false;
      req.socket.destroy();
      return;
    }
    json(res, 200, { turnId: "t", queued: false });
  });
  const client = createPolythClient({ url, token: "pth_x" });
  let operationId = "";
  await assert.rejects(client.sessions.send("s/1", { text: "hello" }), (error: PolythApiError) => {
    assert.equal(error.code, "outcome-unknown");
    assert.equal(error.status, 0);
    operationId = error.operationId ?? "";
    return true;
  });
  assert.match(operationId, /^[0-9a-f-]{36}$/);
  assert.equal(bodies[0]!.clientOperationId, operationId);
  const retried = await client.sessions.send("s/1", { text: "hello", clientOperationId: operationId });
  assert.deepEqual(retried, { turnId: "t", queued: false });
  assert.equal(bodies[1]!.clientOperationId, operationId);
});

test("the stream reconnects from the last event, never skipping or repeating", async (t) => {
  const asked: Array<string | undefined> = [];
  let attempt = 0;
  const url = await serve(t, (req, res) => {
    asked.push(req.headers["last-event-id"] as string | undefined);
    attempt += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (attempt === 1) {
      // Split a frame across writes, then lose the connection.
      res.write(`retry: 3000\n\n: ping\n\n${frame(started(1))}id: 2\ndata: {"seq":2,`);
      setTimeout(() => res.destroy(), 10);
      return;
    }
    // The server replays one already seen; the client must drop it.
    res.write(frame(started(1)) + frame(started(2)));
    res.write(frame({ seq: 3, time: 3, type: "future.event" } as unknown as ClientEvent));
  });
  const client = createPolythClient({ url, token: "pth_x" });
  const abort = new AbortController();
  const seen: number[] = [];
  for await (const event of client.sessions.stream("s", { signal: abort.signal })) {
    seen.push(event.seq);
    if (seen.length === 3) abort.abort();
  }
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(asked, ["0", "1"]);
});

test("the stream ends with an error when access is withdrawn, and retries a shutdown", async (t) => {
  let attempt = 0;
  const url = await serve(t, (_req, res) => {
    attempt += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (attempt === 1) {
      res.end(`event: end\ndata: ${JSON.stringify({ reason: "shutdown" })}\n\n`);
      return;
    }
    res.end(`${frame(started(1))}event: end\ndata: ${JSON.stringify({ reason: "unauthorized" })}\n\n`);
  });
  const client = createPolythClient({ url, token: "pth_x" });
  const seen: number[] = [];
  await assert.rejects((async () => {
    for await (const event of client.sessions.stream("s")) seen.push(event.seq);
  })(), { code: "unauthorized", status: 401 });
  assert.deepEqual(seen, [1]);
  assert.equal(attempt, 2);
});

test("a refused stream fails at once instead of retrying forever", async (t) => {
  let attempts = 0;
  const url = await serve(t, (_req, res) => {
    attempts += 1;
    json(res, 404, { error: "not-found", message: "session not found" });
  });
  const client = createPolythClient({ url, token: "pth_x" });
  await assert.rejects((async () => {
    for await (const event of client.sessions.stream("s")) assert.fail(String(event));
  })(), { status: 404 });
  assert.equal(attempts, 1);
});

test("sign-in asks as an app, shows the code once, and collects the token", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  let polls = 0;
  const url = await serve(t, (req, res, body) => {
    bodies.push(JSON.parse(body) as Record<string, unknown>);
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers["sec-fetch-site"], undefined);
    if (req.url === "/api/auth/cli/device") {
      return json(res, 200, { deviceCode: "d".repeat(64), userCode: "BCDF-GHJK", expiresIn: 600, interval: 1, verificationPath: "/?settings=apps" });
    }
    polls += 1;
    json(res, 200, polls < 2 ? { status: "pending", interval: 1 } : { status: "issued", token: "pth_new" });
  });
  const codes: unknown[] = [];
  const token = await signIn({ url, name: "My bot", access: "approve", onCode: (code) => codes.push(code) });
  assert.equal(token, "pth_new");
  assert.deepEqual(bodies[0], { kind: "app", label: "My bot", profile: "approve" });
  assert.deepEqual(bodies[1], { deviceCode: "d".repeat(64) });
  assert.deepEqual(codes, [{ userCode: "BCDF-GHJK", verificationUrl: `${url}/?settings=apps&code=BCDF-GHJK`, expiresIn: 600 }]);
});

test("a denied sign-in rejects, and it refuses an insecure address before any request", async (t) => {
  const url = await serve(t, (req, res) => {
    if (req.url === "/api/auth/cli/device") return json(res, 200, { deviceCode: "d", userCode: "X", expiresIn: 600, interval: 1, verificationPath: "/?settings=apps" });
    json(res, 403, { error: "forbidden", message: "Access was denied" });
  });
  await assert.rejects(signIn({ url, name: "x", onCode() {} }), { status: 403, message: "Access was denied" });
  await assert.rejects(signIn({ url: "http://polyth.example", name: "x", onCode() { assert.fail("no code"); } }), { code: "insecure-url" });
});
