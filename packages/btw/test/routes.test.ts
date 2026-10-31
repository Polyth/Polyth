import test from "node:test";
import assert from "node:assert/strict";
import type { AuthPrincipal, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import { assertPairedHttpAllowed, validateRemoteAccessPolicy } from "../../server/src/remotePolicy.ts";
import registerPackage, { btwRoutes, type BtwAnswerInput } from "../src/serverEntry.ts";
import type { ServerPackageHost } from "@polyth/plugins";

const sessions: Record<string, { spaceId: string; projection: Partial<SessionProjection> }> = {
  "home-chat": { spaceId: "home", projection: { id: "home-chat", title: "Login fix", status: "working" } },
  "work-chat": { spaceId: "work", projection: { id: "work-chat", title: "Work", status: "idle" } },
  "viewer-chat": { spaceId: "home", projection: { id: "viewer-chat", title: "Shared", status: "idle", sharing: { visibility: "space", access: "view", shared: true } } },
  "people-chat": { spaceId: "home", projection: { id: "people-chat", title: "People", status: "idle", purpose: "conversation" } },
};

function fixture(answer: (input: BtwAnswerInput) => Promise<string> = async () => "  src/login.ts  ") {
  const reads: string[] = [];
  const asked: BtwAnswerInput[] = [];
  const route = btwRoutes({
    forSpace: (ctx: SpaceContext) => ({
      sessions: {
        async snapshot(id: string) {
          const record = sessions[id];
          if (!record || record.spaceId !== ctx.spaceId) throw Object.assign(new Error("session not found"), { code: "not-found" });
          return record.projection as SessionProjection;
        },
        async events(id: string, afterSeq?: number, page?: { limit?: number }) {
          reads.push(`${id}:${afterSeq}:${page?.limit}`);
          return [
            { id: "1", sessionId: id, seq: 1, time: 1, type: "user/message", data: { text: "Fix login" }, v: 1 },
            { id: "2", sessionId: id, seq: 2, time: 2, type: "assistant/message", data: { partId: "p", text: "Edited src/login.ts" }, v: 1 },
          ] as unknown as SessionEvent[];
        },
      },
    }),
    answer: async (input) => { asked.push(input); return answer(input); },
  });
  const request = async (spaceId: string, path: string, body: unknown, method = "POST") => {
    let response: { status: number; body: unknown } | undefined;
    let bodyReads = 0;
    const handled = await route({
      path, method, url: new URL(`http://fixture.test${path}`),
      space: { spaceId, userId: "u1" } as SpaceContext,
      async body() { bodyReads += 1; return body as Record<string, unknown>; },
      json(status: number, value: unknown) { response = { status, body: value }; },
    } as Parameters<typeof route>[0]);
    return { handled, response, bodyReads };
  };
  return { request, reads, asked };
}

test("answers from the chat's own history without touching it", async () => {
  const h = fixture();
  const result = await h.request("home", "/api/sessions/home-chat/btw", { question: "Which file?", thread: [{ question: "q", answer: "a" }] });
  assert.equal(result.handled, true);
  assert.deepEqual(result.response, { status: 200, body: { answer: "src/login.ts" } });
  assert.deepEqual(h.reads, ["home-chat:0:6000"], "one bounded newest-window read");
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0]!.sessionId, "home-chat");
  assert.match(h.asked[0]!.prompt, /User: Fix login\n\nAgent: Edited src\/login\.ts/);
  assert.match(h.asked[0]!.prompt, /still working/);
  assert.match(h.asked[0]!.prompt, /Q: q\nA: a/);
  assert.match(h.asked[0]!.prompt, /Side question: Which file\?$/);
});

test("a known-valid foreign-Space id and an absent id are the same 404, before the body or history", async () => {
  const h = fixture();
  for (const path of ["/api/sessions/work-chat/btw", "/api/sessions/absent/btw", "/api/sessions/%E0%A4%A/btw"]) {
    let bodyReads = -1;
    await assert.rejects(async () => {
      const result = await h.request("home", path, { question: "x" });
      bodyReads = result.bodyReads;
    }, { code: "not-found", message: "Session unavailable" });
    assert.equal(bodyReads, -1);
  }
  assert.deepEqual(h.reads, []);
  assert.equal(h.asked.length, 0);
  assert.equal((await h.request("work", "/api/sessions/work-chat/btw", { question: "x" })).response?.status, 200);
});

test("view-only readers and people conversations cannot ask", async () => {
  const h = fixture();
  await assert.rejects(h.request("home", "/api/sessions/viewer-chat/btw", { question: "x" }), { code: "forbidden" });
  await assert.rejects(h.request("home", "/api/sessions/people-chat/btw", { question: "x" }), { code: "invalid-input" });
  assert.deepEqual(h.reads, []);
});

test("input validation precedes history reads and model work", async () => {
  const h = fixture();
  await assert.rejects(h.request("home", "/api/sessions/home-chat/btw", { question: "" }), { code: "invalid-input" });
  await assert.rejects(h.request("home", "/api/sessions/home-chat/btw", { question: "x".repeat(4_001) }), { code: "invalid-input" });
  await assert.rejects(h.request("home", "/api/sessions/home-chat/btw", { question: "x", thread: Array(7).fill({ question: "q", answer: "a" }) }), { code: "invalid-input" });
  assert.deepEqual(h.reads, []);
  assert.equal(h.asked.length, 0);
});

test("other methods and paths fall through", async () => {
  const h = fixture();
  assert.equal((await h.request("home", "/api/sessions/home-chat/btw", {}, "GET")).handled, false);
  assert.equal((await h.request("home", "/api/sessions/home-chat/btw/extra", {})).handled, false);
  assert.equal((await h.request("home", "/api/sessions/home-chat/fuse", {})).handled, false);
});

test("model failures reach the card as calm, coded errors", async () => {
  const timeout = fixture(async () => { throw new Error("small-model task timed out after 90000ms"); });
  await assert.rejects(timeout.request("home", "/api/sessions/home-chat/btw", { question: "x" }), { code: "unavailable", message: "The model did not answer in time" });
  const coded = fixture(async () => { throw Object.assign(new Error("model gone"), { code: "invalid-model" }); });
  await assert.rejects(coded.request("home", "/api/sessions/home-chat/btw", { question: "x" }), { code: "invalid-model" });
  const empty = fixture(async () => "   ");
  await assert.rejects(empty.request("home", "/api/sessions/home-chat/btw", { question: "x" }), { code: "unavailable" });
});

test("the package runs on the chat's runtime and model, tool-less when the runtime can", async () => {
  const calls: Array<{ kind: string; options: Record<string, unknown> }> = [];
  const runtime = { harnessId: "fake" };
  const fakeHost = (model?: { providerID: string; modelID: string }) => ({
    forSpace: () => ({ sessions: {
      snapshot: async () => ({ id: "home-chat", title: "T", status: "idle" }),
      events: async () => [],
    } }),
    resolveSessionRuntime: async (id: string) => {
      calls.push({ kind: "resolve", options: { id } });
      return { rt: runtime, cwd: "/repo", ...(model ? { model } : {}) };
    },
    smallModelComplete: async (rt: unknown, options: Record<string, unknown>) => {
      assert.equal(rt, runtime);
      calls.push({ kind: "small", options });
      return { text: "direct answer" };
    },
    oneShot: async (rt: unknown, options: Record<string, unknown>) => {
      assert.equal(rt, runtime);
      calls.push({ kind: "oneShot", options });
      return "one-shot answer";
    },
  }) as unknown as ServerPackageHost;
  const run = async (host: ServerPackageHost) => {
    const pkg = registerPackage(host);
    let response: unknown;
    await pkg.routes!({
      path: "/api/sessions/home-chat/btw", method: "POST", url: new URL("http://fixture.test/"),
      space: { spaceId: "home", userId: "u1" } as SpaceContext,
      body: async () => ({ question: "why?" }),
      json: (_status: number, value: unknown) => { response = value; },
    } as never);
    return response;
  };
  assert.deepEqual(await run(fakeHost({ providerID: "p", modelID: "m" })), { answer: "direct answer" });
  const small = calls.find((call) => call.kind === "small")!.options;
  assert.deepEqual(small.model, { providerID: "p", modelID: "m" });
  assert.equal(small.purpose, "btw");
  assert.equal(small.cwd, "/repo");
  assert.match(String(small.systemPrompt), /Do not use tools/);
  assert.equal(small.requireDirect, undefined);
  calls.length = 0;
  assert.deepEqual(await run(fakeHost()), { answer: "one-shot answer" }, "no session model: the runtime's default on a one-shot");
  const oneShot = calls.find((call) => call.kind === "oneShot")!.options;
  assert.equal(oneShot.purpose, "btw");
  assert.match(String(oneShot.prompt), /^You answer a quick side question/);
});

test("paired devices are denied by default: the route stays local like fusion", () => {
  const pkg = registerPackage({} as ServerPackageHost);
  validateRemoteAccessPolicy("btw", pkg.remoteAccess!);
  const device: AuthPrincipal = { kind: "paired-device", deviceId: "d", deviceEndpointId: "e", connectionId: "c", transport: "direct", grantRevision: 1, grants: ["core.sessions.message", "core.sessions.read"] };
  assert.throws(() => assertPairedHttpAllowed(device, "POST", "/api/sessions/home-chat/btw", [{ owner: "btw", policy: pkg.remoteAccess! }]), { code: "forbidden" });
});
