import assert from "node:assert/strict";
import { test } from "node:test";
import { configureAcpCapabilityDelivery } from "../src/capabilityDelivery.ts";
import type { HarnessCapabilityApplicationReceipt, HarnessContext } from "@polyth/contracts";
import type { RpcPeer } from "@polyth/harness-runtime";
import type { AcpLaunchOverlay } from "../src/provisioner.ts";

const context: HarnessContext = { spaceId: "space-a", projectId: "project-a", cwd: "/project/a", sessionId: "canonical-a" };
const overlay = (text = "Project A skill and context", revision = "revision-a") => ({
  value: {
    mcpServers: [{ name: "polyth-agent-tools", command: "node", args: ["bridge.mjs"], env: [{ name: "TOKEN", value: "private-token" }] }],
    mcpHttp: false,
    prompt: { text, capabilityIds: ["fixture.skill", "fixture.context"] },
  } satisfies AcpLaunchOverlay,
  desiredRevision: revision,
});

function fixture(options: { staged?: ReturnType<typeof overlay>; agent?: unknown; harnessId?: string } = {}) {
  let staged: { value: AcpLaunchOverlay; desiredRevision: string } | undefined = options.staged ?? overlay();
  const calls: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  let respond: (method: string, params: unknown) => Promise<unknown> = async (method) =>
    method === "session/new" ? { sessionId: "native-a" } : { stopReason: "end_turn" };
  const rpc: RpcPeer = {
    request: async <T>(method: string, params: unknown, timeoutMs?: number) => {
      calls.push({ method, params, timeoutMs });
      return await respond(method, params) as T;
    },
    notify() {}, onNotification() {}, onRequest() {}, onClose() {}, async close() {},
    authorityId: "authority-a", generation: 1, releasedAuthorities: [], receipts: {}, async receipt() {},
  };
  const before = { notify: rpc.notify, onRequest: rpc.onRequest, close: rpc.close };
  const harnessId = options.harnessId ?? "fixture-agent";
  configureAcpCapabilityDelivery(rpc, context, harnessId, options.agent, {
    peek(ctx, id) { assert.equal(ctx, context); assert.equal(id, harnessId); return staged; },
    acknowledge: (receipt) => { receipts.push(receipt); },
  });
  assert.equal(rpc.notify, before.notify);
  assert.equal(rpc.onRequest, before.onRequest);
  assert.equal(rpc.close, before.close);
  return {
    rpc, calls, receipts,
    stage(next: typeof staged) { staged = next; },
    response(fn: typeof respond) { respond = fn; },
    async create() { return rpc.request("session/new", { cwd: context.cwd, mcpServers: staged?.value.mcpServers ?? [] }); },
    async prompt(id = "native-a") { return rpc.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "/review patch" }] }, 0); },
  };
}

test("session creation does not acknowledge text; prompt preserves user blocks and excludes secrets", async () => {
  const f = fixture();
  await f.create();
  assert.equal(f.receipts.length, 0);
  const prompt = [{ type: "text", text: "/review patch" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  const params = { sessionId: "native-a", prompt, _meta: { trace: "trace-a" } };
  await f.rpc.request("session/prompt", params, 0);
  const outbound = f.calls.at(-1)!;
  assert.deepEqual(outbound.params, { ...params, prompt: [...prompt, { type: "text", text: "Project A skill and context" }] });
  assert.equal(prompt.length, 2);
  assert.equal(outbound.timeoutMs, 0);
  assert.doesNotMatch(JSON.stringify(outbound.params), /private-token|bridge\.mjs/);
  assert.equal(f.receipts.length, 1);
  assert.deepEqual(f.receipts[0], {
    target: { ...context, harnessId: "fixture-agent" }, desiredRevision: "revision-a",
    capabilityIds: ["fixture.skill", "fixture.context"], outcome: "unverifiable",
    reason: "ACP accepted the prompt text projection; native model consumption is not observable",
    evidence: {
      stage: "staged",
      source: "ACP prompt text projection was appended; native model consumption is not observable",
    },
  });
});

test("text repeats on subsequent prompts, including after native compaction", async () => {
  const f = fixture();
  await f.create();
  await f.prompt();
  await f.prompt();
  assert.deepEqual(f.calls[1]?.params, f.calls[2]?.params);
  assert.equal(f.receipts.length, 2);
});

test("a newer staged revision cannot replace a live native session's text", async () => {
  const f = fixture();
  await f.create();
  f.stage(overlay("New revision", "revision-b"));
  await f.prompt();
  assert.match(JSON.stringify(f.calls.at(-1)?.params), /Project A skill/);
  assert.equal(f.receipts[0]?.desiredRevision, "revision-a");
});

for (const method of ["session/load", "session/resume"]) {
  test(`${method} binds the staged text only after the native response`, async () => {
    const f = fixture();
    await f.rpc.request(method, { sessionId: "native-restored", cwd: context.cwd, mcpServers: [] });
    assert.equal(f.receipts.length, 0);
    await f.prompt("native-restored");
    assert.match(JSON.stringify(f.calls.at(-1)?.params), /Project A skill/);
    assert.equal(f.receipts[0]?.desiredRevision, "revision-a");
  });
}

test("another native session cannot receive this projection", async () => {
  const f = fixture();
  await f.create();
  await f.prompt("foreign-session");
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)?.params), /Project A skill/);
  assert.equal(f.receipts.length, 0);
});

test("no staged text in a new session clears the previous projection", async () => {
  const f = fixture();
  await f.create();
  f.stage(undefined);
  await f.create();
  await f.prompt();
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)?.params), /Project A skill/);
  assert.equal(f.receipts.length, 0);
});

test("unknown or rejected prompt responses do not create capability receipts or retries", async () => {
  const f = fixture();
  await f.create();
  const lost = Object.assign(new Error("response lost"), { code: "runtime-disconnected" });
  f.response(async () => { throw lost; });
  await assert.rejects(f.prompt(), (error: unknown) => error === lost);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.calls.filter((c) => c.method === "session/prompt").length, 1);
});

test("failed native creation cannot bind or acknowledge staged text", async () => {
  const f = fixture();
  f.response(async (method) => {
    if (method === "session/new") throw Object.assign(new Error("rejected"), { code: "runtime-rejected" });
    return {};
  });
  await assert.rejects(f.create(), /rejected/);
  await f.prompt();
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)?.params), /Project A skill/);
  assert.equal(f.receipts.length, 0);
});

test("invalid native creation receipts cannot bind text", async () => {
  const f = fixture();
  f.response(async () => ({ sessionId: "" }));
  await f.create();
  await f.prompt();
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)?.params), /Project A skill/);
  assert.equal(f.receipts.length, 0);
});

test("a late old prompt completion cannot acknowledge a replacement session", async () => {
  const f = fixture();
  await f.create();
  let complete!: (value: unknown) => void;
  f.response(async (method) => method === "session/prompt"
    ? new Promise((resolve) => { complete = resolve; }) : { sessionId: "native-b" });
  const old = f.prompt();
  f.stage(overlay("Replacement", "revision-b"));
  await f.create();
  complete({ stopReason: "end_turn" });
  await old;
  assert.equal(f.receipts.length, 0);
});

for (const advertised of [undefined, {}, { mcpCapabilities: {} }, { mcpCapabilities: { http: false } }, { mcpCapabilities: { http: "true" } }]) {
  test(`HTTP MCP is rejected without strict boolean negotiation: ${JSON.stringify(advertised)}`, () => {
    const staged = overlay();
    (staged.value as AcpLaunchOverlay).mcpServers = [{ type: "http", name: "configured", url: "https://example.invalid/mcp", headers: [{ name: "Authorization", value: "private-token" }] }];
    assert.throws(() => fixture({ staged, agent: advertised }), (error: unknown) => {
      assert.equal((error as { code: string }).code, "unsupported");
      assert.doesNotMatch((error as Error).message, /private-token/);
      return true;
    });
  });
}

test("advertised HTTP MCP reaches the native session unchanged", async () => {
  const staged = overlay();
  (staged.value as AcpLaunchOverlay).mcpServers = [{ type: "http", name: "configured", url: "https://example.invalid/mcp", headers: [] }];
  const f = fixture({ staged, agent: { mcpCapabilities: { http: true } } });
  await f.create();
  assert.deepEqual((f.calls[0]?.params as { mcpServers: unknown }).mcpServers, staged.value.mcpServers);
});

test("HTTP negotiation is enforced again if configuration changes before session creation", async () => {
  const f = fixture();
  const staged = overlay();
  (staged.value as AcpLaunchOverlay).mcpServers = [{ type: "http", name: "configured", url: "https://example.invalid/mcp", headers: [] }];
  f.stage(staged);
  await assert.rejects(f.create(), (error: unknown) => (error as { code: string }).code === "runtime-rejected");
  assert.equal(f.calls.length, 0);
  assert.equal(f.receipts.length, 0);
});

test("empty text capability can still receive an honest prompt receipt", async () => {
  const f = fixture({ staged: overlay("") });
  await f.create();
  await f.prompt();
  assert.equal(f.receipts.length, 1);
});
