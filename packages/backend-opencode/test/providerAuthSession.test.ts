import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentRuntime,
  ProviderAuthMethod,
  ProviderAuthWrite,
  ProviderAuthorization,
  RuntimeEndpoint,
} from "@polyth/contracts";
import { createHttpServer } from "../../server/src/http.ts";
import { clearAttemptSecrets, createProviderAuthController } from "../src/providerAuth.ts";
import { providerAuthRoutes } from "../src/providerAuthRoutes.ts";
import {
  LOCAL_OPENCODE_AUTH_PROJECT_ID,
  localOpenCodeAuthContext,
} from "../src/providerAuthTarget.ts";
import { fakeSpaceContext, testTenancy } from "../../server/test/support/spaces.ts";
import { SPACE_HEADER } from "../../server/src/spaces.ts";

const BIZARRE = "zz!!not-a-token!!xyz-42";
const SPACE = fakeSpaceContext();

const oauth = (index = 0, extra: Partial<ProviderAuthMethod> = {}): ProviderAuthMethod => ({
  type: "oauth",
  label: "Sign in",
  upstreamIndex: index,
  ...extra,
});

const apiKey = (index = 1): ProviderAuthMethod => ({
  type: "api",
  label: "API key",
  upstreamIndex: index,
});

const localEndpoint = (generation = 1): RuntimeEndpoint => ({
  authorityId: "local-host",
  continuity: "generation-only",
  generation,
  url: "http://127.0.0.1:4096",
  location: { directory: "/tmp" },
  control: { kind: "owned", instanceToken: "t" },
  config: { kind: "writable", targetId: "local" },
  authentication: { kind: "none" },
});

const sshEndpoint = (generation = 1): RuntimeEndpoint => ({
  authorityId: "ssh-box",
  continuity: "generation-only",
  generation,
  url: "http://127.0.0.1:18000",
  location: { directory: "/home/opencode" },
  control: { kind: "borrowed", source: "external" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

const controller = (
  runtime: AgentRuntime,
  extra: { now?: () => number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; resolve?: (hostname: string) => Promise<string[]> } = {},
) => createProviderAuthController({
  runtime: async () => runtime,
  invalidateModels: () => {},
  ...extra,
});

const methodIdOf = async (
  auth: ReturnType<typeof createProviderAuthController>,
  providerId = "acme",
  index = 0,
  space = SPACE,
) => {
  const caps = await auth.capabilities(new Set(), space);
  const method = caps.providers[providerId]?.methods[index];
  assert.ok(method, `missing method ${index} for ${providerId}`);
  return method.id;
};

const start = async (
  auth: ReturnType<typeof createProviderAuthController>,
  extra: { providerId?: string; index?: number; inputs?: Record<string, string>; revision?: string; browserLocality?: "native-desktop" | "unknown"; space?: typeof SPACE } = {},
) => {
  const providerId = extra.providerId ?? "acme";
  const space = extra.space ?? SPACE;
  const methodId = await methodIdOf(auth, providerId, extra.index ?? 0, space);
  return auth.startAttempt({
    providerId,
    methodId,
    space,
    browserLocality: extra.browserLocality ?? "unknown",
    ...(extra.inputs ? { inputs: extra.inputs } : {}),
    ...(extra.revision ? { revision: extra.revision } : {}),
  });
};

const listen = async (runtime: AgentRuntime, auth = controller(runtime)) => {
  const tenancy = await testTenancy();
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: { forProject: async () => runtime },
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-provider-auth-")),
    version: "test",
    routes: [providerAuthRoutes({ auth, runtime: async () => runtime })],
    visibility: {
      catalog: () => [],
      available: (_models: unknown, _live: unknown, ids: string[]) => ids.map((id) => ({ id, name: id })),
      filter: (models: unknown) => models,
      setProviderEnabled: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
      addProvider: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
      removeProvider: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
      setModelEnabled: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
    } as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { server, port, auth, close: () => server.close() };
};

const jsonError = async (res: Response) => {
  const body = await res.json() as { error?: string; details?: string };
  return body;
};

test("capability failure is not turned into an API-key method", async () => {
  const runtime = {
    providerAuthMethods: async () => { throw Object.assign(new Error("boom"), { code: "unavailable" }); },
  } as unknown as AgentRuntime;
  const { port, close } = await listen(runtime);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers/auth-capabilities`);
    assert.equal(res.status, 200);
    const body = await res.json() as { discovery: { status: string }; providers: Record<string, { methods: unknown[] }> };
    assert.equal(body.discovery.status, "failed");
    assert.equal(Object.values(body.providers).some((view) => view.methods.length > 0), false);
  } finally {
    close();
  }
});

test("oauth failure leaves the API method available and does not zombie the attempt", async () => {
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({
      acme: [oauth(0), apiKey(1)],
    }),
    providerAuthorize: async () => { throw Object.assign(new Error("oauth down"), { status: 503 }); },
    setProviderApiKey: async () => true,
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const caps = await auth.capabilities(new Set(), SPACE);
  assert.equal(caps.providers.acme?.methods.length, 2);
  await assert.rejects(() => start(auth, { index: 0 }));
  assert.equal((await auth.view("acme", false, SPACE)).activeAttempt, undefined);
  const saved = await auth.saveCredential("acme", "sk-test", undefined, SPACE);
  assert.equal(saved.credential?.verification, "saved");
});

test("missing API key and missing oauth capabilities leave no starting zombie", async () => {
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({
      acme: [oauth(0), apiKey(1)],
    }),
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  await assert.rejects(() => start(auth, { index: 1, inputs: {} }));
  await assert.rejects(() => start(auth, { index: 0 }));
  const view = await auth.view("acme", false, SPACE);
  assert.equal(view.activeAttempt, undefined);
});

test("stale revision and fingerprint changes fail before mutating upstream", async () => {
  let methods: Record<string, ProviderAuthMethod[]> = { acme: [oauth(0)] };
  let callbacks = 0;
  const runtime = {
    providerAuthMethods: async () => methods,
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => { callbacks += 1; return true; },
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const first = await start(auth);
  const oldRevision = (await auth.capabilities(new Set(), SPACE)).revision;
  methods = { acme: [apiKey(0)] };
  auth.invalidate();
  await assert.rejects(() => start(auth, { revision: oldRevision }));
  await assert.rejects(() => auth.completeAttempt(first.id, "late", SPACE));
  assert.equal(callbacks, 0);

  methods = { acme: [oauth(0, { prompts: [{ type: "text", key: "url", message: "URL" }] })] };
  auth.invalidate();
  const prompted = await start(auth, { inputs: { url: "https://gitlab.example" } });
  methods = { acme: [oauth(0, { prompts: [{ type: "text", key: "host", message: "Host" }] })] };
  auth.invalidate();
  await assert.rejects(() => auth.completeAttempt(prompted.id, "code", SPACE));
  assert.equal(callbacks, 0);

  methods = {
    acme: [oauth(0, { label: "Browser" }), oauth(1, { label: "Device" })],
  };
  auth.invalidate();
  const ordered = await start(auth, { index: 1 });
  methods = {
    acme: [oauth(0, { label: "Device" }), oauth(1, { label: "Browser" })],
  };
  auth.invalidate();
  await assert.rejects(() => auth.completeAttempt(ordered.id, "code", SPACE));
  assert.equal(callbacks, 0);
});

test("a second attempt supersedes the first and rejects the old callback", async () => {
  let callbackCount = 0;
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste the code",
    }),
    providerAuthCallback: async () => { callbackCount += 1; return true; },
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const first = await start(auth);
  const second = await start(auth);
  assert.equal(auth.getAttempt(first.id, SPACE)?.phase, "stale");
  await assert.rejects(() => auth.completeAttempt(first.id, "late-code", SPACE));
  const done = await auth.completeAttempt(second.id, "http://localhost:9/callback?code=good", SPACE);
  assert.equal(done.phase, "connected");
  assert.equal(callbackCount, 1);
});

test("concurrent completions invoke the upstream callback once", async () => {
  let callbackCount = 0;
  let release!: () => void;
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => { started = resolve; });
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => {
      callbackCount += 1;
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return true;
    },
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const attempt = await start(auth);
  const pending = Promise.all([
    auth.completeAttempt(attempt.id, "one", SPACE),
    auth.completeAttempt(attempt.id, "two", SPACE),
  ]);
  await startedP;
  release();
  const [a, b] = await pending;
  assert.equal(a.phase, "connected");
  assert.equal(b.phase, "connected");
  assert.equal(callbackCount, 1);
});

test("runtime restart fences only the owning authority", async () => {
  const runtime = {
    endpoint: async () => localEndpoint(1),
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => true,
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const attempt = await start(auth);
  auth.notifyRuntimeChange(sshEndpoint(9));
  assert.equal(auth.getAttempt(attempt.id, SPACE)?.phase, "awaiting_code");
  auth.notifyRuntimeChange(localEndpoint(2));
  assert.equal(auth.getAttempt(attempt.id, SPACE)?.phase, "stale");
  await assert.rejects(() => auth.completeAttempt(attempt.id, "late", SPACE));
});

test("cancelled auto callback ignores a late success", async () => {
  let resume: (value: boolean) => void;
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "auto",
      instructions: "Continue",
    }),
    providerAuthCallback: async () => new Promise<boolean>((resolve) => { resume = resolve; }),
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const attempt = await start(auth);
  auth.cancelAttempt(attempt.id, SPACE);
  resume!(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(auth.getAttempt(attempt.id, SPACE)?.phase, "cancelled");
});

test("SSH runtime is not a provider-auth target; unknown topology only warns", async () => {
  const authorizeLoopback = async (): Promise<ProviderAuthorization> => ({
    url: "https://id.example/oauth/authorize?redirect_uri=http://127.0.0.1:9/cb",
    method: "auto",
    instructions: "Continue",
  });
  const ssh = controller({
    endpoint: async () => sshEndpoint(),
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: authorizeLoopback,
    providerAuthCallback: async () => true,
  } as unknown as AgentRuntime);
  const sshCaps = await ssh.capabilities(new Set(), SPACE);
  assert.equal(sshCaps.discovery.status, "unavailable");
  assert.equal(sshCaps.discovery.error?.code, "AUTH_CAPABILITY_UNAVAILABLE");
  await assert.rejects(
    () => ssh.startAttempt({ providerId: "acme", methodId: "missing", space: SPACE }),
    (error: Error & { code?: string }) => error.code === "AUTH_CAPABILITY_UNAVAILABLE",
  );

  const unknown = controller({
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: authorizeLoopback,
    providerAuthCallback: async () => new Promise<boolean>(() => {}),
  } as unknown as AgentRuntime);
  const unknownAttempt = await start(unknown);
  assert.notEqual(unknownAttempt.phase, "failed");
  assert.equal(unknownAttempt.loopbackWarning, true);
  assert.ok(unknownAttempt.phase === "browser_action_required" || unknownAttempt.phase === "waiting");

  const localUnknownBrowser = controller({
    endpoint: async () => localEndpoint(),
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: authorizeLoopback,
    providerAuthCallback: async () => new Promise<boolean>(() => {}),
  } as unknown as AgentRuntime);
  const localAttempt = await start(localUnknownBrowser);
  assert.notEqual(localAttempt.phase, "failed");
  assert.equal(localAttempt.loopbackWarning, true);
});

test("well-known command persists stdout token server-side and never returns it", async () => {
  const stored: Array<{ id: string; info: ProviderAuthWrite }> = [];
  const script = join(mkdtempSync(join(tmpdir(), "wk-auth-")), "token.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(script, `process.stdout.write(${JSON.stringify(BIZARRE)}); process.stderr.write("diag-only");`);
  const auth = controller({
    endpoint: async () => localEndpoint(),
    setProviderAuth: async (id: string, info: ProviderAuthWrite) => { stored.push({ id, info }); return true; },
  } as unknown as AgentRuntime, {
    resolve: async () => ["203.0.113.8"],
    fetchImpl: async () => new Response(JSON.stringify({
      auth: {
        command: [process.execPath, script],
        env: "OPENCODE_ORG_TOKEN",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const preview = await auth.previewWellKnown("https://org.example", SPACE);
  assert.deepEqual(preview.command, [process.execPath, script]);
  assert.equal(preview.env, "OPENCODE_ORG_TOKEN");
  assert.equal(JSON.stringify(preview).includes(BIZARRE), false);
  const result = await auth.executeWellKnown("https://org.example", preview.hash, SPACE);
  assert.deepEqual(result, { ok: true });
  assert.equal(JSON.stringify(result).includes(BIZARRE), false);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.id, "https://org.example");
  assert.deepEqual(stored[0]?.info, { type: "wellknown", key: "OPENCODE_ORG_TOKEN", token: BIZARRE });
  await assert.rejects(() => auth.executeWellKnown("https://org.example", preview.hash, SPACE));
});

test("well-known review is required, expired, and env-validated", async () => {
  let now = 1_000;
  const auth = controller({
    endpoint: async () => localEndpoint(),
  } as unknown as AgentRuntime, {
    now: () => now,
    resolve: async () => ["203.0.113.8"],
    fetchImpl: async () => new Response(JSON.stringify({ auth: { command: ["echo", "x"], env: "ORG_TOKEN" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const preview = await auth.previewWellKnown("https://org.example", SPACE);
  await assert.rejects(() => auth.executeWellKnown("https://org.example", "wrong-hash", SPACE));
  now += 6 * 60 * 1000;
  await assert.rejects(() => auth.executeWellKnown("https://org.example", preview.hash, SPACE));
});

test("well-known metadata addresses are blocked before fetch", async () => {
  const auth = controller({
    endpoint: async () => localEndpoint(),
  } as unknown as AgentRuntime, {
    fetchImpl: async () => { throw new Error("should not fetch metadata"); },
  });
  await assert.rejects(() => auth.previewWellKnown("http://169.254.169.254", SPACE));
  await assert.rejects(() => auth.previewWellKnown("http://metadata.google.internal", SPACE));
  await assert.rejects(() => auth.previewWellKnown("http://[fd00:ec2::254]", SPACE));
});

test("duplicate completion is idempotent and does not call OpenCode twice", async () => {
  let callbackCount = 0;
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => { callbackCount += 1; return true; },
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const attempt = await start(auth);
  await auth.completeAttempt(attempt.id, "one", SPACE);
  const again = await auth.completeAttempt(attempt.id, "two", SPACE);
  assert.equal(again.phase, "connected");
  assert.equal(callbackCount, 1);
});

test("removing stored credentials keeps environment source visible", async () => {
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({}),
    listAllProviders: async () => [{ id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"] }],
    removeProviderAuth: async () => true,
  } as unknown as AgentRuntime;
  const auth = controller(runtime, { env: { OPENAI_API_KEY: BIZARRE } });
  const disconnected = await auth.disconnect("openai", SPACE);
  assert.equal(disconnected.remaining?.source, "environment");
  assert.deepEqual(disconnected.remaining?.envVarNames, ["OPENAI_API_KEY"]);
  assert.equal(JSON.stringify(disconnected).includes(BIZARRE), false);
});

test("active attempts are rediscovered from capabilities after a remount", async () => {
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "auto",
      instructions: "Continue",
    }),
    providerAuthCallback: async () => new Promise<boolean>(() => {}),
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const attempt = await start(auth);
  const caps = await auth.capabilities(new Set(), SPACE);
  assert.equal(caps.providers.acme?.activeAttempt?.id, attempt.id);
});

test("attempt complete without an attempt is stale; authorize+complete calls callback once", async () => {
  let callbackCount = 0;
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({
      "github-copilot": [oauth(0)],
    }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "auto",
      instructions: "Continue",
    }),
    providerAuthCallback: async () => { callbackCount += 1; return true; },
  } as unknown as AgentRuntime;
  const { port, close } = await listen(runtime);
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/missing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status >= 400, true);
    assert.equal((await jsonError(missing)).error, "AUTH_SESSION_STALE");
    assert.equal(callbackCount, 0);

    const caps = await fetch(`http://127.0.0.1:${port}/api/providers/auth-capabilities`);
    const body = await caps.json() as { providers: Record<string, { methods: Array<{ id: string }> }> };
    const methodId = body.providers["github-copilot"]?.methods[0]?.id;
    assert.ok(methodId);
    const authorize = await fetch(`http://127.0.0.1:${port}/api/providers/github-copilot/auth/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ methodId }),
    });
    assert.equal(authorize.status, 200);
    const started = await authorize.json() as { id?: string };
    assert.ok(started.id);
    const complete = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(complete.status, 200);
    const again = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(again.status, 200);
    assert.equal(callbackCount, 1);
  } finally {
    close();
  }
});

test("terminal attempts are forgotten after TTL", async () => {
  let now = 1_000;
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => true,
  } as unknown as AgentRuntime;
  const auth = controller(runtime, { now: () => now });
  const attempt = await start(auth);
  await auth.completeAttempt(attempt.id, "ok", SPACE);
  now += 6 * 60 * 1000;
  assert.equal(auth.getAttempt(attempt.id, SPACE), undefined);
});

test("single-flight discovery does not waterfall", async () => {
  let calls = 0;
  let release!: () => void;
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { acme: [oauth(0)] };
    },
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const pending = Promise.all([auth.capabilities(new Set(), SPACE), auth.capabilities(new Set(), SPACE)]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await pending;
  assert.equal(calls, 1);
});

test("required API prompts besides the key are rejected before mutation", async () => {
  let saved = 0;
  const auth = controller({
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({
      acme: [{
        type: "api",
        label: "API key",
        upstreamIndex: 0,
        prompts: [{ type: "text", key: "region", message: "Region" }],
      }],
    }),
    setProviderApiKey: async () => { saved += 1; return true; },
  } as unknown as AgentRuntime);
  await assert.rejects(
    () => start(auth, { inputs: { key: "sk-test" } }),
    (error: Error & { code?: string; field?: string }) => error.code === "AUTH_INPUT_INVALID" && error.field === "region",
  );
  assert.equal(saved, 0);
});

test("auto device OAuth keeps the device phase while the callback runs", async () => {
  const auth = controller({
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/device",
      method: "auto",
      instructions: "Enter code ABCD-EFGH at https://example.test/device",
    }),
    providerAuthCallback: async () => new Promise<boolean>(() => {}),
  } as unknown as AgentRuntime);
  const attempt = await start(auth);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(auth.getAttempt(attempt.id, SPACE)?.phase, "device_action_required");
  assert.equal(auth.getAttempt(attempt.id, SPACE)?.userCode, "ABCD-EFGH");
});

test("a successful terminal attempt is no longer the active mapping", async () => {
  const auth = controller({
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => true,
  } as unknown as AgentRuntime);
  const attempt = await start(auth);
  await auth.completeAttempt(attempt.id, "good-code", SPACE);
  assert.equal((await auth.view("acme", true, SPACE)).activeAttempt, undefined);
});

test("local OpenCode auth context never picks a project from the registry", () => {
  const space = fakeSpaceContext({
    spaceId: "space-a",
    spaceSlug: "space-a",
    userId: "user-a",
    storageDir: "/tmp/space-a",
  });
  const ctx = localOpenCodeAuthContext(space, "/var/lib/polyth");
  assert.equal(ctx.projectId, LOCAL_OPENCODE_AUTH_PROJECT_ID);
  assert.equal(ctx.remote, false);
  assert.equal(ctx.spaceId, "space-a");
  assert.equal(ctx.cwd, "/var/lib/polyth");
  assert.notEqual(ctx.cwd, process.cwd());
  assert.equal(ctx.space, space);
});

test("clearAttemptSecrets zeroizes values so they cannot linger after a terminal transition", () => {
  const secrets = [BIZARRE, "second-secret"];
  clearAttemptSecrets(secrets);
  assert.deepEqual(secrets, []);
});

test("well-known pin is bound to the reviewed local authority", async () => {
  let generation = 1;
  const stored: Array<{ id: string }> = [];
  const script = join(mkdtempSync(join(tmpdir(), "wk-pin-")), "token.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(script, `process.stdout.write("tok");`);
  const auth = controller({
    endpoint: async () => localEndpoint(generation),
    setProviderAuth: async (id: string) => { stored.push({ id }); return true; },
  } as unknown as AgentRuntime, {
    resolve: async () => ["203.0.113.8"],
    fetchImpl: async () => new Response(JSON.stringify({
      auth: { command: [process.execPath, script], env: "OPENCODE_ORG_TOKEN" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const preview = await auth.previewWellKnown("https://org.example", SPACE);
  generation = 2;
  await assert.rejects(
    () => auth.executeWellKnown("https://org.example", preview.hash, SPACE),
    (error: Error & { code?: string; details?: string }) =>
      error.code === "AUTH_WELLKNOWN_UNSAFE" && Boolean(error.details?.includes("auth target")),
  );
  assert.equal(stored.length, 0);
});

test("well-known preview refuses a remote OpenCode host", async () => {
  const auth = controller({
    endpoint: async () => sshEndpoint(),
    setProviderAuth: async () => true,
  } as unknown as AgentRuntime, {
    resolve: async () => ["203.0.113.8"],
    fetchImpl: async () => new Response(JSON.stringify({
      auth: { command: ["echo", "x"], env: "OPENCODE_ORG_TOKEN" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    () => auth.previewWellKnown("https://org.example", SPACE),
    (error: Error & { code?: string }) => error.code === "AUTH_CAPABILITY_UNAVAILABLE",
  );
});

test("connected status comes from the OpenCode runtime models, not the generic catalog", async () => {
  const runtime = {
    endpoint: async () => localEndpoint(),
    models: async () => [
      { providerID: "anthropic", modelID: "claude", name: "Claude", connected: true },
      { providerID: "openai", modelID: "gpt", name: "GPT", connected: false },
    ],
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({
      anthropic: [apiKey(0)],
      openai: [apiKey(0)],
    }),
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const tenancy = await testTenancy();
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: { forProject: async () => runtime },
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-provider-auth-")),
    version: "test",
    routes: [providerAuthRoutes({
      auth,
      runtime: async () => runtime,
      catalog: {
        invalidateModels: () => {},
        models: async () => [{ providerID: "openai", modelID: "gpt", name: "GPT", connected: true }],
      },
      visibility: {
        catalog: () => [{ id: "openai", connected: true }],
        available: () => [],
      },
    })],
    visibility: {} as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/providers/auth-capabilities`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      providers: Record<string, { credential?: { verification?: string } }>;
    };
    assert.equal(body.providers.anthropic?.credential?.verification, "verified");
    assert.equal(body.providers.openai?.credential, undefined);
  } finally {
    server.close();
  }
});

test("server-trusted and multi-tenant-sandboxed cannot mutate host OpenCode credentials", async () => {
  let methods = 0;
  let saved = 0;
  let authorized = 0;
  let disconnected = 0;
  let persisted = 0;
  const runtime = {
    endpoint: async () => localEndpoint(),
    providerAuthMethods: async () => {
      methods += 1;
      return { acme: [oauth(0), apiKey(1)] };
    },
    setProviderApiKey: async () => { saved += 1; return true; },
    providerAuthorize: async () => { authorized += 1; return { url: "https://example.test/oauth", method: "code", instructions: "x" }; },
    providerAuthCallback: async () => true,
    removeProviderAuth: async () => { disconnected += 1; return true; },
    setProviderAuth: async () => { persisted += 1; return true; },
  } as unknown as AgentRuntime;
  const auth = controller(runtime, {
    resolve: async () => ["203.0.113.8"],
    fetchImpl: async () => new Response(JSON.stringify({ auth: { command: ["echo", "x"], env: "ORG_TOKEN" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  for (const deployment of ["server-trusted", "multi-tenant-sandboxed"] as const) {
    const denied = fakeSpaceContext({ deployment });
    const caps = await auth.capabilities(new Set(), denied);
    assert.equal(caps.discovery.status, "unavailable");
    assert.equal(caps.discovery.error?.code, "AUTH_CAPABILITY_UNAVAILABLE");
    assert.equal(methods, 0);
    await assert.rejects(() => auth.saveCredential("acme", "sk-test", undefined, denied));
    await assert.rejects(() => auth.startAttempt({ providerId: "acme", methodId: "x", space: denied }));
    await assert.rejects(() => auth.disconnect("acme", denied));
    await assert.rejects(() => auth.previewWellKnown("https://org.example", denied));
    await assert.rejects(() => auth.executeWellKnown("https://org.example", "hash", denied));
    assert.equal(saved, 0);
    assert.equal(authorized, 0);
    assert.equal(disconnected, 0);
    assert.equal(persisted, 0);
  }
});

test("attempts stay isolated across Spaces that share the host-global OpenCode store", async () => {
  const spaceA = fakeSpaceContext({ spaceId: "spc_a", spaceSlug: "a" });
  const spaceB = fakeSpaceContext({ spaceId: "spc_b", spaceSlug: "b" });
  const runtime = {
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => true,
  } as unknown as AgentRuntime;
  const auth = controller(runtime);
  const a = await start(auth, { space: spaceA });
  const b = await start(auth, { space: spaceB });
  assert.notEqual(a.id, b.id);
  assert.equal(auth.getAttempt(a.id, spaceB), undefined);
  assert.equal(auth.getAttempt(b.id, spaceA), undefined);
  await assert.rejects(() => auth.completeAttempt(a.id, "stolen", spaceB));
  assert.throws(() => auth.cancelAttempt(a.id, spaceB));
  assert.equal((await auth.capabilities(new Set(), spaceB)).providers.acme?.activeAttempt?.id, b.id);
  assert.equal((await auth.capabilities(new Set(), spaceA)).providers.acme?.activeAttempt?.id, a.id);
  const done = await auth.completeAttempt(a.id, "good", spaceA);
  assert.equal(done.phase, "connected");
  assert.equal(auth.getAttempt(b.id, spaceB)?.phase, "awaiting_code");
});

test("well-known generation change during the command blocks persistence", async () => {
  let generation = 1;
  const stored: Array<{ id: string }> = [];
  const script = join(mkdtempSync(join(tmpdir(), "wk-gen-")), "token.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(script, "await new Promise((r) => setTimeout(r, 120)); process.stdout.write('tok');");
  const auth = controller({
    endpoint: async () => localEndpoint(generation),
    setProviderAuth: async (id: string) => { stored.push({ id }); return true; },
  } as unknown as AgentRuntime, {
    resolve: async () => ["203.0.113.8"],
    fetchImpl: async () => new Response(JSON.stringify({
      auth: { command: [process.execPath, script], env: "OPENCODE_ORG_TOKEN" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const preview = await auth.previewWellKnown("https://org.example", SPACE);
  const pending = auth.executeWellKnown("https://org.example", preview.hash, SPACE);
  await new Promise((resolve) => setTimeout(resolve, 40));
  generation = 2;
  await assert.rejects(
    () => pending,
    (error: Error & { code?: string }) => error.code === "AUTH_RUNTIME_RESTARTED",
  );
  assert.equal(stored.length, 0);
});

test("HTTP Space B cannot operate on Space A attempts or well-known reviews", async () => {
  const stored: string[] = [];
  const script = join(mkdtempSync(join(tmpdir(), "wk-iso-")), "token.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(script, "process.stdout.write('tok');");
  const runtime = {
    endpoint: async () => localEndpoint(),
    providerAuthMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({ acme: [oauth(0)] }),
    providerAuthorize: async (): Promise<ProviderAuthorization> => ({
      url: "https://example.test/oauth/authorize",
      method: "code",
      instructions: "Paste",
    }),
    providerAuthCallback: async () => true,
    setProviderAuth: async (id: string) => { stored.push(id); return true; },
  } as unknown as AgentRuntime;
  const tenancy = await testTenancy();
  const spaceB = tenancy.addSpace("Other");
  const auth = controller(runtime, {
    resolve: async () => ["203.0.113.8"],
    fetchImpl: async () => new Response(JSON.stringify({
      auth: { command: [process.execPath, script], env: "OPENCODE_ORG_TOKEN" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: { forProject: async () => runtime },
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-provider-auth-")),
    version: "test",
    routes: [providerAuthRoutes({ auth, runtime: async () => runtime })],
    visibility: {} as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const headerB = { [SPACE_HEADER]: spaceB.spaceId, "content-type": "application/json" };
  try {
    const caps = await (await fetch(`http://127.0.0.1:${port}/api/providers/auth-capabilities`)).json() as {
      providers: Record<string, { methods: Array<{ id: string }> }>;
    };
    const methodId = caps.providers.acme?.methods[0]?.id;
    assert.ok(methodId);
    const started = await (await fetch(`http://127.0.0.1:${port}/api/providers/acme/auth/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ methodId }),
    })).json() as { id: string };
    const stolenGet = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}`, {
      headers: { [SPACE_HEADER]: spaceB.spaceId },
    });
    assert.equal(stolenGet.status >= 400, true);
    assert.equal((await jsonError(stolenGet)).error, "AUTH_SESSION_STALE");
    const stolenComplete = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}/complete`, {
      method: "POST",
      headers: headerB,
      body: JSON.stringify({ code: "stolen" }),
    });
    assert.equal(stolenComplete.status >= 400, true);
    const stolenCancel = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}`, {
      method: "DELETE",
      headers: { [SPACE_HEADER]: spaceB.spaceId },
    });
    assert.equal(stolenCancel.status >= 400, true);
    const stillA = await fetch(`http://127.0.0.1:${port}/api/providers/auth/attempts/${started.id}`);
    assert.equal(stillA.status, 200);

    const previewA = await (await fetch(`http://127.0.0.1:${port}/api/providers/auth/well-known/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://org.example" }),
    })).json() as { hash: string };
    const stealBeforeReview = await fetch(`http://127.0.0.1:${port}/api/providers/auth/well-known/execute`, {
      method: "POST",
      headers: headerB,
      body: JSON.stringify({ origin: "https://org.example", hash: previewA.hash, confirm: true }),
    });
    assert.equal(stealBeforeReview.status >= 400, true);
    assert.equal(stored.length, 0);
    const previewB = await (await fetch(`http://127.0.0.1:${port}/api/providers/auth/well-known/preview`, {
      method: "POST",
      headers: headerB,
      body: JSON.stringify({ origin: "https://org.example" }),
    })).json() as { hash: string };
    assert.equal(previewA.hash, previewB.hash);
    const stealReview = await fetch(`http://127.0.0.1:${port}/api/providers/auth/well-known/execute`, {
      method: "POST",
      headers: headerB,
      body: JSON.stringify({ origin: "https://org.example", hash: previewA.hash, confirm: true }),
    });
    assert.equal(stealReview.status, 200);
    assert.equal(stored.length, 1);
    const aStill = await fetch(`http://127.0.0.1:${port}/api/providers/auth/well-known/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://org.example", hash: previewA.hash, confirm: true }),
    });
    assert.equal(aStill.status, 200);
    assert.equal(stored.length, 2);
    const reuseB = await fetch(`http://127.0.0.1:${port}/api/providers/auth/well-known/execute`, {
      method: "POST",
      headers: headerB,
      body: JSON.stringify({ origin: "https://org.example", hash: previewB.hash, confirm: true }),
    });
    assert.equal(reuseB.status >= 400, true);
  } finally {
    server.close();
  }
});


