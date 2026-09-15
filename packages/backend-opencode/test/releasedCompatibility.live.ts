/**
 * Opt-in compatibility evidence for released OpenCode binaries.
 *
 * Run once per released binary, for example:
 *   OPENCODE_COMPAT_BIN=/tmp/polyth-opencode-v2-arm/bin/opencode \
 *     node --experimental-strip-types --test packages/backend-opencode/test/releasedCompatibility.live.ts
 *
 * No inference or external authentication occurs. V2 also stores a dummy key
 * in its isolated HOME, checks persistence, and removes it through the API.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject, RuntimeEndpoint, RuntimeSessionBinding } from "@polyth/contracts";
import {
  createOpenCodeRuntime,
  type ManagedOpenCodeRuntime,
  type OwnedRuntimeLifecycle,
} from "../src/index.ts";

type OwnedCompatibilityRuntime = ManagedOpenCodeRuntime & {
  lifecycle: OwnedRuntimeLifecycle;
  protocol: NonNullable<ManagedOpenCodeRuntime["protocol"]>;
};

const binary = process.env.OPENCODE_COMPAT_BIN;
const LIVE = {
  skip: binary ? false : "set OPENCODE_COMPAT_BIN to run against a released OpenCode binary",
  timeout: 120_000,
  concurrency: false,
};

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 20_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
};

const headersFor = async (endpoint: RuntimeEndpoint): Promise<Record<string, string>> =>
  endpoint.authentication.kind === "endpoint-headers"
    ? await endpoint.authentication.resolve()
    : {};

const request = async (
  endpoint: RuntimeEndpoint,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const url = new URL(path, endpoint.url);
  url.searchParams.set("directory", endpoint.location.directory);
  const headers = new Headers(await headersFor(endpoint));
  headers.set("content-type", "application/json");
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
};

const bindingFor = (
  endpoint: RuntimeEndpoint,
  canonicalSessionId: string,
  backendSessionId: string,
  reconciliationOrdinal: number,
): RuntimeSessionBinding & { reconciliationOrdinal: number } => ({
  canonicalSessionId,
  backendSessionId,
  authorityId: endpoint.authorityId,
  generation: endpoint.generation,
  continuity: endpoint.continuity,
  location: endpoint.location,
  reconciliationOrdinal,
});

const asData = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const data = (value as { data?: unknown }).data;
  assert.ok(data && typeof data === "object" && !Array.isArray(data));
  return data as Record<string, unknown>;
};

const expectStatus = async (response: Response, status: number): Promise<void> => {
  if (response.status !== status) assert.fail(await response.text());
};

const createV2Form = async (
  endpoint: RuntimeEndpoint,
  backendSessionId: string,
  id: string,
): Promise<void> => {
  const response = await request(endpoint, `/api/session/${encodeURIComponent(backendSessionId)}/form`, {
    method: "POST",
    body: JSON.stringify({
      id,
      title: "Compatibility form",
      fields: [
        {
          key: "choice",
          type: "string",
          title: "Choice",
          required: true,
          options: [{ value: "allow", label: "Allow" }],
        },
        { key: "count", type: "integer", title: "Count", required: true },
        { key: "confirmed", type: "boolean", title: "Confirmed", required: true },
      ],
    }),
  });
  await expectStatus(response, 200);
  const data = asData(await response.json());
  assert.equal(data.id, id);
  assert.equal(data.sessionID, backendSessionId);
};

const formState = async (
  endpoint: RuntimeEndpoint,
  backendSessionId: string,
  formId: string,
): Promise<Record<string, unknown>> => {
  const response = await request(
    endpoint,
    `/api/session/${encodeURIComponent(backendSessionId)}/form/${encodeURIComponent(formId)}/state`,
  );
  await expectStatus(response, 200);
  return asData(await response.json());
};

test("live: released OpenCode compatibility facade owns isolated legacy or V2 session evidence", LIVE, async () => {
  assert.ok(binary);
  assert.ok(existsSync(binary), `OPENCODE_COMPAT_BIN does not exist: ${binary}`);
  const root = await mkdtemp(join(tmpdir(), "polyth-opencode-compat-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const configDir = join(root, "config");
  const runtimeDir = join(root, "runtime");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(configDir), mkdir(runtimeDir)]);

  const savedEnvironment = new Map<string, string | undefined>();
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "OPENAI_API_KEY"]) {
    savedEnvironment.set(key, process.env[key]);
  }
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.XDG_CACHE_HOME = join(home, "cache");
  delete process.env.OPENAI_API_KEY;

  let runtime: OwnedCompatibilityRuntime | undefined;
  try {
    runtime = await createOpenCodeRuntime({
      projectId: "released-compatibility",
      cwd: workspace,
      bin: binary,
      binarySource: "configured",
      configDir,
      runtimeDir,
      stateFile: join(root, "state.json"),
      startupDeadlineMs: 25_000,
      probeDeadlineMs: 2_000,
    }) as OwnedCompatibilityRuntime;

    const protocol = await runtime.protocol();
    assert.ok(protocol === "legacy" || protocol === "v2");

    // Read-only catalog and provider discovery. Fresh HOME/XDG/config means
    // this cannot discover the caller's provider credentials.
    assert.ok(Array.isArray(await runtime.models()));
    assert.ok(Array.isArray(await runtime.agents()));
    assert.ok(Array.isArray(await runtime.listAllProviders!()));
    assert.ok(typeof await runtime.providerAuthMethods!() === "object");
    const openaiConnections = async () => {
      const current = await runtime!.endpoint!();
      const response = await request(current, `/api/integration?${new URLSearchParams({ "location[directory]": workspace })}`);
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Array<{ id: string; connections: unknown[] }> };
      const integration = body.data.find((row) => row.id === "openai");
      assert.ok(integration);
      return integration.connections;
    };
    if (protocol === "v2") {
      assert.equal((await openaiConnections()).length, 0);
      assert.equal(await runtime.setProviderApiKey!("openai", "polyth-local-compatibility-dummy-key"), true);
      assert.equal((await openaiConnections()).length, 1);
    }

    const canonicalSessionId = "compat-session";
    const backendSessionId = await runtime.ensureSession({
      projectId: "released-compatibility",
      sessionId: canonicalSessionId,
      title: "Released compatibility",
      cwd: workspace,
    });
    assert.match(backendSessionId, /^ses_/);
    assert.equal((await runtime.sessions()).some((row) => row.id === backendSessionId), true);
    assert.deepEqual(await runtime.history(backendSessionId), []);

    const lifecycleEvents: string[] = [];
    const lifecycleSubscription = runtime.onLifecycle?.((event) => {
      if (event.type === "stream-connected") lifecycleEvents.push(`${event.authorityId}:${event.generation}`);
    });
    try {
      // The first connection may finish before a subscriber is attached. In
      // that case restart once to establish the before-restart stream event.
      if (lifecycleEvents.length === 0) {
        await runtime.lifecycle.restart("manual");
        await waitFor(() => lifecycleEvents.length > 0, "SSE did not connect before the restart evidence");
      }
      const streamEventsBeforeRestart = lifecycleEvents.length;
      await runtime.lifecycle.restart("manual");
      await waitFor(
        () => lifecycleEvents.length > streamEventsBeforeRestart,
        "SSE did not reconnect after the owned runtime restart",
      );
    } finally {
      lifecycleSubscription?.dispose();
    }

    let endpoint = await runtime.endpoint!();
    if (protocol === "v2") {
      assert.ok((await runtime.providerAuthMethods!()).openai?.length);
      assert.equal((await openaiConnections()).length, 1, "native credential persists through runtime restart");
      assert.equal(await runtime.removeProviderAuth!("openai"), true);
      assert.equal((await openaiConnections()).length, 0);
    }
    if (protocol === "v2") {
      const permissions = await request(endpoint, `/api/session/${encodeURIComponent(backendSessionId)}/permission`);
      await expectStatus(permissions, 200);
      const permissionEnvelope = await permissions.json() as { data?: unknown };
      assert.ok(Array.isArray(permissionEnvelope.data));

      const observedQuestions: string[] = [];
      const observationSubscription = runtime.onObservation!((sessionId, observation) => {
        if (sessionId !== canonicalSessionId) return;
        for (const event of observation.events) {
          if (event.type === "question/asked") observedQuestions.push(event.requestId);
        }
      });
      const firstForm = "frm_compat_reply";
      try {
        // The reconciliation barrier is required before an SSE observation can
        // become canonical evidence. The raw form then supplies an actual V2
        // stream event before the following owned restart.
        const snapshot = await runtime.reconcile!(bindingFor(endpoint, canonicalSessionId, backendSessionId, 1));
        assert.deepEqual(snapshot.questions, []);
        await createV2Form(endpoint, backendSessionId, firstForm);
        await waitFor(
          () => observedQuestions.includes(firstForm),
          "V2 form.created did not arrive on the stream before restart",
        );
        const reply = await runtime.replyQuestionOperation!(
          canonicalSessionId,
          firstForm,
          { answers: [["allow"], ["7"], ["true"]] } as JsonObject,
          "compat-form-reply",
        );
        assert.equal(reply.kind, "confirmed");
        const answered = await formState(endpoint, backendSessionId, firstForm);
        assert.equal(answered.status, "answered");
        assert.deepEqual(answered.answer, { choice: "allow", count: 7, confirmed: true });

        let reconnected = false;
        const reconnectSubscription = runtime.onLifecycle?.((event) => {
          if (event.type === "stream-connected") reconnected = true;
        });
        await runtime.lifecycle.restart("manual");
        await waitFor(() => reconnected, "V2 SSE did not reconnect before post-restart form evidence");
        reconnectSubscription?.dispose();
        endpoint = await runtime.endpoint!();
        const secondForm = "frm_compat_cancel";
        const secondSnapshot = await runtime.reconcile!(bindingFor(endpoint, canonicalSessionId, backendSessionId, 2));
        assert.deepEqual(secondSnapshot.questions, []);
        await createV2Form(endpoint, backendSessionId, secondForm);
        await waitFor(
          () => observedQuestions.includes(secondForm),
          "V2 form.created did not arrive on the stream after restart",
        );
        const cancelled = await runtime.replyQuestionOperation!(
          canonicalSessionId,
          secondForm,
          { action: "reject", answers: [[], [], []] } as JsonObject,
          "compat-form-cancel",
        );
        assert.equal(cancelled.kind, "confirmed");
        assert.equal((await formState(endpoint, backendSessionId, secondForm)).status, "cancelled");
      } finally {
        observationSubscription.dispose();
      }

      const idleInterrupt = await runtime.abortOperation!(canonicalSessionId, "compat-idle-interrupt");
      assert.equal(idleInterrupt.kind, "rejected");
      if (idleInterrupt.kind === "rejected") assert.equal(idleInterrupt.code, "not-running");
    }

    // The facade retains its canonical mapping through owned restart, so the
    // final deletion is a real protocol mutation rather than raw cleanup.
    endpoint = await runtime.endpoint!();
    await runtime.discardSession!(canonicalSessionId);
    assert.equal((await runtime.sessions()).some((row) => row.id === backendSessionId), false);
  } finally {
    await runtime?.dispose().catch(() => undefined);
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
