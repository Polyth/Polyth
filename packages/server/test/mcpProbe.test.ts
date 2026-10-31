import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { callMcpTool, inspectMcpServer } from "../src/mcpProbe.ts";

const SECRET = "mcp-probe-secret-value";
const AMBIENT_OPENAI = "sk-ambient-openai";
const AMBIENT_ANTHROPIC = "sk-ambient-anthropic";

interface FixtureReport {
  pid: number;
  cwd: string;
  ambientOpenAI: string | null;
  ambientAnthropic: string | null;
  marker: string | null;
  tokenMatch: boolean;
  methods: string[];
  serverReplies: Array<number | null>;
}

const FIXTURE = `import { createInterface } from "node:readline";
import { renameSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const reportPath = process.argv[3];
const expectedToken = process.argv[4] ?? "";
const methods = [];
const serverReplies = [];
let initId;
const report = () => {
const temporary = reportPath + ".tmp";
writeFileSync(temporary, JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  ambientOpenAI: process.env.OPENAI_API_KEY ?? null,
  ambientAnthropic: process.env.ANTHROPIC_API_KEY ?? null,
  marker: process.env.MCP_PROBE_MARKER ?? null,
  tokenMatch: process.env.MCP_TOKEN === expectedToken,
  methods,
  serverReplies,
}));
renameSync(temporary, reportPath);
};
report();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const serverInfo = { name: "fixture", version: "1.0.0" };
const initialized = (id) => send({
  jsonrpc: "2.0",
  id,
  result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo },
});
const tool = (name, description) => ({
  name,
  ...(description === undefined ? {} : { description }),
  inputSchema: { type: "object" },
});
createInterface({ input: process.stdin }).on("line", (line) => {
  if (mode === "huge") {
    process.stdout.write("x".repeat(80000) + "\\n");
    return;
  }
  if (mode === "malformed") {
    methods.push("malformed");
    report();
    process.stdout.write("not-json\\n");
    return;
  }
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.method === "string") methods.push(msg.method);
  report();
  if (msg.method === "server/discover") {
    if (mode === "ignore-discover") return;
    if (mode === "modern") {
      send({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } } });
      return;
    }
    if (mode === "modern-error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32022, message: "Unsupported version", data: { supported: ["2099-01-01"] } } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown method" } });
    return;
  }
  if (msg.id === "srv-1") {
    serverReplies.push(msg.error && msg.error.code);
    report();
    initialized(initId);
    return;
  }
  if (msg.method === "initialize") {
    initId = msg.id;
    if (mode === "server-request") {
      send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list" });
      return;
    }
    if (mode === "rpc-error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom " + (process.env.MCP_TOKEN ?? "") } });
      return;
    }
    if (mode === "hang") return;
    initialized(msg.id);
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/call") {
    if (mode === "call-hang") return;
    if (mode === "call-malformed") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: "invalid content" } });
      return;
    }
    if (mode === "call-rpc-error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "invalid " + process.env.MCP_TOKEN } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo " + process.env.MCP_TOKEN }], isError: mode === "call-error" } });
    return;
  }
  if (msg.method !== "tools/list") return;
  const token = process.env.MCP_TOKEN ?? "";
  if (mode === "paginate" && !msg.params?.cursor) {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [tool("alpha", "first")], nextCursor: "c2" } });
    return;
  }
  if (mode === "loop") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [tool("loop-" + methods.length)], nextCursor: "again" } });
    return;
  }
  if (mode === "huge-schema") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "alpha", inputSchema: { type: "object", description: "z".repeat(20000) } }] } });
    return;
  }
  if (mode === "deep-schema") {
    // rozetka-mcp shape: filters.additionalProperties.anyOf[].items.anyOf[].type is depth 9.
    const deep = { type: "object", properties: { filters: { type: "object", additionalProperties: { anyOf: [
      { type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
    ] } } } };
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "search", description: "find products", inputSchema: deep },
      { name: "alpha", description: "first", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ] } });
    return;
  }
  if (mode === "edge-description") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [tool("alpha", "e".repeat(4000))] } });
    return;
  }
  if (mode === "long-description") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [tool("alpha", "d".repeat(5497))] } });
    return;
  }
  if (mode === "too-many-tools") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: Array.from({ length: 129 }, (_, index) => tool("t" + index)) } });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: msg.id,
    result: {
      tools: [{
        name: "echo",
        description: "token " + token,
        inputSchema: { type: "object", properties: { note: { const: token } } },
      }],
    },
  });
});
`;

let resourcesDir: string | undefined;
const temps: string[] = [];

const ensureSupervisor = (): void => {
  if (resourcesDir) return;
  const root = mkdtempSync(join(tmpdir(), "polyth-mcp-supervisor-"));
  temps.push(root);
  const destDir = join(root, "runtime-supervisor", `linux-${process.arch}`);
  mkdirSync(destDir, { recursive: true });
  const output = join(destDir, "polyth-supervisor");
  const source = fileURLToPath(new URL("../../harness-runtime/native/polyth-supervisor.c", import.meta.url));
  const compiled = spawnSync("cc", [
    "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static-pie",
    "-Wl,-z,relro,-z,now", source, "-o", output,
  ], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr || "supervisor compile failed");
  chmodSync(output, 0o755);
  resourcesDir = root;
  process.env.POLYTH_RESOURCES_DIR = root;
};

after(() => {
  for (const directory of temps) rmSync(directory, { recursive: true, force: true });
});

const workspace = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-mcp-probe-"));
  temps.push(directory);
  return directory;
};

const readReport = (file: string): FixtureReport => JSON.parse(readFileSync(file, "utf8")) as FixtureReport;

const waitDead = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture ${pid} is still running`);
};

const withAmbient = async (run: () => Promise<void>): Promise<void> => {
  const previous = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    marker: process.env.MCP_PROBE_MARKER,
  };
  process.env.OPENAI_API_KEY = AMBIENT_OPENAI;
  process.env.ANTHROPIC_API_KEY = AMBIENT_ANTHROPIC;
  process.env.MCP_PROBE_MARKER = "kept";
  try {
    await run();
  } finally {
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
    if (previous.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous.anthropic;
    if (previous.marker === undefined) delete process.env.MCP_PROBE_MARKER;
    else process.env.MCP_PROBE_MARKER = previous.marker;
  }
};

const probeStdio = async (mode: string, timeoutMs = 8_000) => {
  ensureSupervisor();
  const root = workspace();
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const fixture = join(root, "fixture.mjs");
  const report = join(root, "report.json");
  const authorityFile = join(root, "authority.json");
  writeFileSync(fixture, FIXTURE, { mode: 0o600 });
  const result = await inspectMcpServer({
    transport: { kind: "stdio", command: process.execPath, args: [fixture, mode, report, SECRET], envKeys: ["MCP_TOKEN"] },
    secrets: { MCP_TOKEN: SECRET },
    cwd,
    authorityFile,
    timeoutMs,
  });
  return { result, report, authorityFile, cwd };
};

const noSecret = (value: unknown): void => {
  assert.equal(JSON.stringify(value).includes(SECRET), false);
  assert.equal(JSON.stringify(value).includes(AMBIENT_OPENAI), false);
  assert.equal(JSON.stringify(value).includes(AMBIENT_ANTHROPIC), false);
};

const released = (file: string): { released: boolean; generation: number } => {
  const state = JSON.parse(readFileSync(file, "utf8")) as { released?: boolean; generation?: number };
  return { released: state.released === true, generation: state.generation ?? 0 };
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const listen = (onRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) =>
  new Promise<{ url: string; hits: number; close: () => Promise<void> }>((resolve, reject) => {
    let hits = 0;
    const server = createServer((request, response) => {
      hits += 1;
      void Promise.resolve(onRequest(request, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server has no port"));
        return;
      }
      resolve({
        get hits() { return hits; },
        url: `http://127.0.0.1:${address.port}/mcp`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });

test("public-only MCP probes reject loopback before connecting", async () => {
  const server = await listen((_request, response) => response.end());
  try {
    const result = await inspectMcpServer({
      transport: { kind: "http", url: server.url, headersSecretRefs: [] },
      secrets: {}, authorityFile: join(workspace(), "http-authority.json"), networkPolicy: "public-only",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /private|loopback|blocked|public/i);
    assert.equal(server.hits, 0);
  } finally { await server.close(); }
});

test("stdio inventory redacts secrets, drops ambient credentials, and proves release", { timeout: 25_000 }, async () => {
  await withAmbient(async () => {
    const first = await probeStdio("ok");
    const report = readReport(first.report);
    assert.equal(first.result.ok, true);
    assert.equal(first.result.serverInfo?.name, "fixture");
    assert.equal(first.result.serverInfo?.version, "1.0.0");
    assert.equal(first.result.tools.length, 1);
    assert.equal(first.result.tools[0]?.name, "echo");
    assert.match(first.result.tools[0]?.description ?? "", /\[redacted\]/);
    assert.equal((first.result.tools[0]?.inputSchema.properties as { note?: { const?: string } } | undefined)?.note?.const, "[redacted]");
    noSecret(first.result);
    assert.equal(report.tokenMatch, true);
    assert.equal(report.ambientOpenAI, null);
    assert.equal(report.ambientAnthropic, null);
    assert.equal(report.marker, null, "arbitrary ambient values are not MCP credentials");
    assert.equal(report.cwd, first.cwd);
    assert.deepEqual(report.methods, ["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    const firstGeneration = released(first.authorityFile);
    assert.equal(firstGeneration.released, true);
    await waitDead(report.pid);

    const again = await inspectMcpServer({
      transport: { kind: "stdio", command: process.execPath, args: [join(first.cwd, "..", "fixture.mjs"), "ok", first.report, SECRET], envKeys: ["MCP_TOKEN"] },
      secrets: { MCP_TOKEN: SECRET },
      cwd: first.cwd,
      authorityFile: first.authorityFile,
      timeoutMs: 8_000,
    });
    assert.equal(again.ok, true);
    const after = released(first.authorityFile);
    assert.equal(after.released, true);
    assert.ok(after.generation > firstGeneration.generation);
  });
});

test("stdio tools/list follows a bounded cursor and stops on a repeated cursor", { timeout: 25_000 }, async () => {
  await withAmbient(async () => {
    const page = await probeStdio("paginate");
    assert.equal(page.result.ok, true);
    assert.deepEqual(page.result.tools.map((tool) => tool.name), ["alpha", "echo"]);
    noSecret(page.result);
    assert.equal(released(page.authorityFile).released, true);
    await waitDead(readReport(page.report).pid);

    const loop = await probeStdio("loop");
    assert.equal(loop.result.ok, false);
    assert.equal(loop.result.tools.length, 0);
    assert.match(loop.result.message, /cursor/i);
    noSecret(loop.result);
    assert.equal(released(loop.authorityFile).released, true);
    await waitDead(readReport(loop.report).pid);
  });
});

test("stdio protocol errors, malformed frames, and oversized schemas fail closed", { timeout: 30_000 }, async () => {
  await withAmbient(async () => {
    const error = await probeStdio("rpc-error");
    assert.equal(error.result.ok, false);
    assert.equal(error.result.tools.length, 0);
    assert.match(error.result.message, /boom/);
    noSecret(error.result);
    assert.equal(released(error.authorityFile).released, true);

    const malformed = await probeStdio("malformed");
    assert.equal(malformed.result.ok, false);
    assert.match(malformed.result.message, /malformed/i);
    assert.equal(released(malformed.authorityFile).released, true);

    const huge = await probeStdio("huge");
    assert.equal(huge.result.ok, false);
    assert.match(huge.result.message, /frame|bounds/i);
    assert.equal(released(huge.authorityFile).released, true);

    const schema = await probeStdio("huge-schema");
    assert.equal(schema.result.ok, false);
    assert.match(schema.result.message, /bounds/i);
    noSecret(schema.result);
    assert.equal(released(schema.authorityFile).released, true);
  });
});

test("oversized tool descriptions and over-deep schemas degrade instead of failing the whole server", { timeout: 30_000 }, async () => {
  await withAmbient(async () => {
    const edge = await probeStdio("edge-description");
    assert.equal(edge.result.ok, true, edge.result.message);
    assert.equal(edge.result.tools.length, 1);
    assert.equal(edge.result.tools[0]?.description, "e".repeat(4_000));
    noSecret(edge.result);
    assert.equal(released(edge.authorityFile).released, true);
    await waitDead(readReport(edge.report).pid);

    const long = await probeStdio("long-description");
    assert.equal(long.result.ok, true, long.result.message);
    assert.equal(long.result.tools.length, 1);
    assert.equal(long.result.tools[0]?.name, "alpha");
    assert.equal(long.result.tools[0]?.description?.length, 4_000);
    assert.match(long.result.tools[0]?.description ?? "", /\[truncated\]$/);
    assert.equal(long.result.tools[0]?.description, "d".repeat(4_000 - " …[truncated]".length) + " …[truncated]");
    noSecret(long.result);
    assert.equal(released(long.authorityFile).released, true);
    await waitDead(readReport(long.report).pid);

    const deep = await probeStdio("deep-schema");
    assert.equal(deep.result.ok, true, deep.result.message);
    assert.deepEqual(deep.result.tools.map((entry) => entry.name), ["search", "alpha"]);
    assert.deepEqual(deep.result.tools[0]?.inputSchema, { type: "object" });
    assert.match(deep.result.tools[0]?.description ?? "", /^find products\n\n\[Input schema omitted/);
    assert.deepEqual(deep.result.tools[1]?.inputSchema, { type: "object", properties: { q: { type: "string" } } }, "an in-bounds schema keeps its shape");
    noSecret(deep.result);
    assert.equal(released(deep.authorityFile).released, true);
    await waitDead(readReport(deep.report).pid);

    const many = await probeStdio("too-many-tools");
    assert.equal(many.result.ok, false);
    assert.equal(many.result.tools.length, 0);
    assert.match(many.result.message, /bounds/i);
    assert.equal(released(many.authorityFile).released, true);
    await waitDead(readReport(many.report).pid);
  });
});

test("stdio answers server requests as unsupported and never calls tools", { timeout: 20_000 }, async () => {
  await withAmbient(async () => {
    const probed = await probeStdio("server-request");
    assert.equal(probed.result.ok, true);
    assert.equal(probed.result.tools[0]?.name, "echo");
    const report = readReport(probed.report);
    assert.deepEqual(report.serverReplies, [-32601]);
    assert.equal(report.methods.includes("tools/call"), false);
    assert.deepEqual(report.methods, ["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    noSecret(probed.result);
    assert.equal(released(probed.authorityFile).released, true);
    await waitDead(report.pid);
  });
});

test("stdio timeout fails and the fixture process is released", { timeout: 25_000 }, async () => {
  await withAmbient(async () => {
    const started = Date.now();
    const probed = await probeStdio("hang", 600);
    assert.equal(probed.result.ok, false);
    assert.match(probed.result.message, /timed out/i);
    assert.equal(probed.result.tools.length, 0);
    noSecret(probed.result);
    assert.ok(Date.now() - started < 20_000);
    assert.equal(released(probed.authorityFile).released, true);
    await waitDead(readReport(probed.report).pid);
  });
});

test("streamable HTTP JSON and SSE inventory redact headers and keep the session on one origin", { timeout: 15_000 }, async () => {
  const root = workspace();
  const authorityFile = join(root, "authority.json");
  const secret = "http-header-secret-value";
  const seen: string[] = [];
  const sessions: string[] = [];
  const json = await listen(async (request, response) => {
    if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
    const body = JSON.parse(await readBody(request)) as { id?: number; method?: string; params?: { cursor?: string } };
    seen.push(body.method ?? "");
    sessions.push(String(request.headers["mcp-session-id"] ?? ""));
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401);
      response.end(secret);
      return;
    }
    if (body.method === "server/discover") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown method" } }));
      return;
    }
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "2.0.0" } }
      : body.method === "tools/list" && !body.params?.cursor
        ? { tools: [{ name: "one", inputSchema: { type: "object" } }], nextCursor: "p2" }
        : body.method === "tools/list"
          ? { tools: [{ name: "two", description: `see ${secret}`, inputSchema: { type: "object", const: secret } }] }
          : undefined;
    if (body.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    if (request.headers.accept?.includes("text/event-stream") && body.method === "tools/list" && body.params?.cursor) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "mcp-session-id": "sess-1",
      });
      response.end(`event: message\ndata: ${payload}\n\n`);
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      ...(body.method === "initialize" ? { "mcp-session-id": "sess-1" } : {}),
    });
    response.end(payload);
  });
  try {
    const result = await inspectMcpServer({
      transport: { kind: "http", url: json.url, headersSecretRefs: ["Authorization"] },
      secrets: { Authorization: `Bearer ${secret}` },
      authorityFile,
      timeoutMs: 4_000,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools.map((tool) => tool.name), ["one", "two"]);
    assert.match(result.tools[1]?.description ?? "", /\[redacted\]/);
    assert.equal(result.tools[1]?.inputSchema.const, "[redacted]");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.serverInfo?.name, "http-fixture");
    assert.deepEqual(seen, ["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/list"]);
    assert.deepEqual(sessions, ["", "", "sess-1", "sess-1", "sess-1"]);
    assert.equal(existsSync(authorityFile), false);
  } finally {
    await json.close();
  }
});

test("HTTP 401, redirects, metadata, and embedded credentials fail without leaking secrets", { timeout: 15_000 }, async () => {
  const root = workspace();
  const authorityFile = join(root, "authority.json");
  const secret = "http-header-secret-value";
  let forwarded = false;
  const dest = await listen(async (request, response) => {
    if (String(request.headers.authorization ?? "").includes(secret)) forwarded = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const denied = await listen(async (_request, response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end(`denied ${secret}`);
  });
  const redirect = await listen(async (_request, response) => {
    response.writeHead(302, { location: dest.url });
    response.end(secret);
  });
  try {
    const unauthorized = await inspectMcpServer({
      transport: { kind: "http", url: denied.url, headersSecretRefs: ["Authorization"] },
      secrets: { Authorization: secret },
      authorityFile,
      timeoutMs: 2_000,
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.message, "HTTP 401");
    assert.equal(unauthorized.tools.length, 0);
    assert.equal(unauthorized.message.includes(secret), false);

    const redirected = await inspectMcpServer({
      transport: { kind: "http", url: redirect.url, headersSecretRefs: ["Authorization"] },
      secrets: { Authorization: secret },
      authorityFile,
      timeoutMs: 2_000,
    });
    assert.equal(redirected.ok, false);
    assert.match(redirected.message, /redirect/i);
    assert.equal(forwarded, false);
    assert.equal(dest.hits, 0);
    assert.equal(redirected.message.includes(secret), false);

    const metadata = await inspectMcpServer({
      transport: { kind: "http", url: "http://169.254.169.254/latest/meta-data", headersSecretRefs: ["Authorization"] },
      secrets: { Authorization: secret },
      authorityFile,
      timeoutMs: 2_000,
    });
    assert.equal(metadata.ok, false);
    assert.match(metadata.message, /metadata|link-local/i);
    assert.equal(metadata.message.includes(secret), false);

    const embedded = await inspectMcpServer({
      transport: { kind: "http", url: `http://user:${encodeURIComponent(secret)}@127.0.0.1:9/mcp`, headersSecretRefs: [] },
      secrets: {},
      authorityFile,
      timeoutMs: 2_000,
    });
    assert.equal(embedded.ok, false);
    assert.match(embedded.message, /credential/i);
    assert.equal(embedded.message.includes(secret), false);
    assert.equal(existsSync(authorityFile), false);
  } finally {
    await dest.close();
    await denied.close();
    await redirect.close();
  }
});

test("HTTP timeout and a held SSE response fail instead of reporting connected", { timeout: 15_000 }, async () => {
  const root = workspace();
  const authorityFile = join(root, "authority.json");
  const hung = await listen(() => new Promise(() => undefined));
  const started = Date.now();
  try {
    const result = await inspectMcpServer({
      transport: { kind: "http", url: hung.url, headersSecretRefs: [] },
      secrets: {},
      authorityFile,
      timeoutMs: 600,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/i);
    assert.equal(result.tools.length, 0);
    assert.ok(Date.now() - started < 8_000);
  } finally {
    await hung.close();
  }
});

test("modern discovery and a silent legacy pre-initialize server use the correct protocol era", async () => {
  for (const mode of ["modern", "ignore-discover", "modern-error"]) {
    const probed = await probeStdio(mode, 1_500);
    const methods = readReport(probed.report).methods;
    assert.equal(probed.result.ok, mode !== "modern-error");
    assert.equal(methods.includes("initialize"), mode === "ignore-discover");
    assert.equal(methods.includes("tools/call"), false);
    assert.equal(released(probed.authorityFile).released, true);
  }
});

test("stdio calls execute once, redact results, and preserve definitive tool errors", async () => {
  ensureSupervisor();
  for (const mode of ["call", "call-error", "call-rpc-error", "call-hang", "call-malformed"]) {
    const root = workspace(), fixture = join(root, "fixture.mjs"), report = join(root, "report.json"), authorityFile = join(root, "authority.json");
    writeFileSync(fixture, FIXTURE);
    const input = { transport: { kind: "stdio" as const, command: process.execPath, args: [fixture, mode, report, SECRET], envKeys: ["MCP_TOKEN"] }, secrets: { MCP_TOKEN: SECRET }, cwd: root, authorityFile, timeoutMs: 1_000, toolName: "echo", arguments: {} };
    if (mode === "call-hang" || mode === "call-malformed") await assert.rejects(callMcpTool(input), { code: "outcome-unknown" });
    else if (mode === "call-rpc-error") await assert.rejects(callMcpTool(input), (error: Error & { code?: string }) => {
      assert.match(error.message, /invalid \[redacted\]/);
      assert.notEqual(error.code, "outcome-unknown");
      return true;
    });
    else {
      const result = await callMcpTool(input);
      assert.equal(result.isError, mode === "call-error");
      noSecret(result);
      assert.match(JSON.stringify(result), /\[redacted\]/);
    }
    const logged = readReport(report);
    assert.equal(logged.methods.filter((method) => method === "tools/call").length, 1);
    assert.equal(released(authorityFile).released, true);
    await waitDead(logged.pid);
  }
});

test("cancelling an admitted MCP call proves process release and does not replay it", async () => {
  ensureSupervisor();
  const root = workspace(), fixture = join(root, "fixture.mjs"), report = join(root, "report.json"), authorityFile = join(root, "authority.json");
  writeFileSync(fixture, FIXTURE);
  const controller = new AbortController();
  const input = { transport: { kind: "stdio" as const, command: process.execPath, args: [fixture, "call-hang", report, SECRET], envKeys: ["MCP_TOKEN"] }, secrets: { MCP_TOKEN: SECRET }, cwd: root, authorityFile, timeoutMs: 3_000, toolName: "echo", arguments: {}, signal: controller.signal };
  const pending = callMcpTool(input);
  const checked = assert.rejects(pending, { code: "outcome-unknown" });
  for (let attempts = 0; attempts < 100; attempts++) {
    if (existsSync(report) && readReport(report).methods.includes("tools/call")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  await checked;
  assert.equal(readReport(report).methods.filter((method) => method === "tools/call").length, 1);
  assert.equal(released(authorityFile).released, true);
  const before = readReport(report).pid;
  await assert.rejects(callMcpTool(input), { code: "cancelled" });
  assert.equal(readReport(report).pid, before, "pre-cancelled calls never launch another process");
});

test("modern HTTP reads a complete event before stream closure and mirrors validated tool headers", async () => {
  let calls = 0;
  const seen: string[] = [];
  const server = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    seen.push(body.method);
    assert.equal(request.headers["mcp-method"], body.method);
    assert.equal(request.headers["mcp-protocol-version"], "2026-07-28");
    assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    let result;
    if (body.method === "server/discover") result = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
    if (body.method === "tools/list") result = { resultType: "complete", tools: [
      { name: "echo", inputSchema: { type: "object", properties: { note: { type: "string", "x-mcp-header": "Note" } } } },
      { name: "invalid", inputSchema: { type: "object", properties: { bad: { type: "number", "x-mcp-header": "Bad" } } } },
    ] };
    if (body.method === "tools/call") {
      calls++;
      assert.equal(request.headers["mcp-name"], "echo");
      assert.equal(request.headers["mcp-param-note"], "=?base64?" + Buffer.from(" Привіт\n").toString("base64") + "?=");
      result = { resultType: "complete", content: [{ type: "text", text: "done" }], structuredContent: { value: 1 } };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
    // Keep the stream open: the client owns completion after the final frame.
  });
  try {
    const input = { transport: { kind: "http" as const, url: server.url, headersSecretRefs: [] }, secrets: {}, authorityFile: join(workspace(), "unused.json"), timeoutMs: 1_500 };
    const inspected = await inspectMcpServer(input);
    assert.equal(inspected.ok, true, inspected.message);
    assert.deepEqual(inspected.tools.map((tool) => tool.name), ["echo"]);
    const result = await callMcpTool({ ...input, toolName: "echo", arguments: { note: " Привіт\n" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    assert.equal(calls, 1);
    assert.equal(seen.includes("initialize"), false);
  } finally { await server.close(); }
});
