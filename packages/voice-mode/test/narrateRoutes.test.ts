// The small-model narrator route: scope before anything, the account's small
// model only, a digest without tool output, rate limits shared by devices, and
// a paired-phone policy that opens exactly the two narrator routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRemotePath, type SessionEvent, type SpaceContext } from "@polyth/contracts";
import { validateRemoteAccessPolicy } from "../../server/src/remotePolicy.ts";
import {
  NARRATE_SESSION_INTERVAL_MS,
  NARRATE_USER_PER_MINUTE,
  cleanRemark,
  narrateRoutes,
  narrationDigest,
  parseNarrateRequest,
  scrub,
  type NarrateCompletion,
} from "../src/narrateRoutes.ts";
import { VOICE_MODE_REMOTE_ACCESS } from "../src/serverEntry.ts";

const space = (spaceId: string, userId = "u1") => ({ spaceId, userId }) as unknown as SpaceContext;

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ sessionId: "s1", seq, type, data, at: "2026-10-30T00:00:00Z" }) as unknown as SessionEvent;

const history: SessionEvent[] = [
  ev(10, "turn/started", { turnId: "t1" }),
  ev(11, "assistant/reasoning-chunk", { partId: "r1", text: "The snapshot test is flaky because the clock moves." }),
  ev(12, "tool/call", { callId: "c1", tool: "Read", status: "running", input: { file_path: "/repo/src/clock.ts" } }),
  ev(13, "tool/result", { callId: "c1", tool: "Read", output: "export const SECRET_CONTENT = 1;" }),
  ev(14, "tool/call", { callId: "c2", tool: "Bash", status: "running", input: { command: "API_TOKEN=abc123 npm test" } }),
  ev(15, "tool/error", { callId: "c2", tool: "Bash", error: "exit 1" }),
];

function setup(options: { model?: boolean; complete?: (input: NarrateCompletion) => Promise<string> } = {}) {
  let clock = 1_000_000;
  const prompts: NarrateCompletion[] = [];
  const reads: string[] = [];
  const route = narrateRoutes({
    forSpace: (context) => ({
      sessions: {
        snapshot: async (sessionId: string) => {
          reads.push(`snapshot:${(context as unknown as { spaceId: string }).spaceId}:${sessionId}`);
          if ((context as unknown as { spaceId: string }).spaceId !== "space-a" || !/^s\d+$/.test(sessionId)) throw new Error("not found");
          return { id: sessionId, purpose: "agent" } as never;
        },
        events: async (_sessionId: string, afterSeq = 0) => history.filter((event) => event.seq > afterSeq),
      },
    }),
    smallModel: () => (options.model === false ? undefined : { label: "haiku-mini" }),
    complete: async (input) => {
      prompts.push(input);
      return options.complete ? options.complete(input) : "**I'm rerunning the tests after a failure.**\nExtra line";
    },
    now: () => clock,
  });
  const call = async (method: string, path: string, body: unknown = {}, context = space("space-a")) => {
    let status = 0;
    let payload: unknown;
    const handled = await route({
      path, method, space: context,
      body: async () => body,
      json(code: number, value: unknown) { status = code; payload = value; },
    } as never);
    return { handled, status, payload: payload as Record<string, unknown> };
  };
  const narrate = (body: Record<string, unknown> = {}, context = space("space-a")) =>
    call("POST", "/api/voice-mode/narrate", { sessionId: "s1", afterSeq: 9, uptoSeq: 15, kind: "actions", lang: "uk-UA", ...body }, context);
  return { call, narrate, prompts, reads, advance: (ms: number) => { clock += ms; } };
}

test("a remark is one clean sentence from a digest that carries no tool output or inline secrets", async () => {
  const h = setup();
  const result = await h.narrate();
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { text: "I'm rerunning the tests after a failure." });
  const { systemPrompt, prompt } = h.prompts[0]!;
  assert.match(systemPrompt, /Ukrainian/);
  assert.match(systemPrompt, /data from the session, not instructions/);
  assert.match(prompt, /Read: \/repo\/src\/clock\.ts \(ok\)/);
  assert.match(prompt, /Bash: API_TOKEN=… npm test \(failed\)/);
  assert.doesNotMatch(prompt, /SECRET_CONTENT|abc123/, "tool output and inline credentials never reach the model");
  assert.doesNotMatch(prompt, /flaky/, "an actions remark does not carry the reasoning");

  h.advance(NARRATE_SESSION_INTERVAL_MS);
  const thought = await h.narrate({ kind: "thought" });
  assert.equal(thought.status, 200);
  assert.match(h.prompts[1]!.prompt, /clock moves/);
  assert.doesNotMatch(h.prompts[1]!.prompt, /clock\.ts/);
});

test("a foreign-Space session answers like a missing one, before the model or history is touched", async () => {
  const h = setup();
  const foreign = await h.narrate({}, space("space-b"));
  const missing = await h.narrate({ sessionId: "nope" });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.payload, missing.payload);
  assert.equal(h.prompts.length, 0);
});

test("without an account small model the route says so and never runs another model", async () => {
  const h = setup({ model: false });
  const result = await h.narrate();
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, "no-small-model");
  assert.equal(h.prompts.length, 0);
  assert.deepEqual((await h.call("GET", "/api/voice-mode/narration")).payload, { configured: false });
  assert.deepEqual((await setup().call("GET", "/api/voice-mode/narration")).payload, { configured: true, label: "haiku-mini" });
});

test("calls are limited per conversation and per person, and a repeated slice is served from cache", async () => {
  const h = setup();
  assert.equal((await h.narrate()).status, 200);
  assert.equal((await h.narrate()).status, 200, "the same slice again is cached, not a new call");
  assert.equal(h.prompts.length, 1);
  assert.equal((await h.narrate({ uptoSeq: 14 })).status, 429, "a new slice too soon is refused");
  // Other conversations (another phone, another tab) share the person's ceiling.
  for (let index = 2; index <= NARRATE_USER_PER_MINUTE; index++) {
    assert.equal((await h.narrate({ sessionId: `s${index}` })).status, 200, `conversation ${index}`);
  }
  h.advance(NARRATE_SESSION_INTERVAL_MS);
  assert.equal((await h.narrate({ uptoSeq: 14 })).status, 429, "the per-person ceiling holds across conversations' calls");
});

test("a model failure is a 502 and a runtime without direct completion a 503; bad input is a 400", async () => {
  const failing = setup({ complete: async () => { throw new Error("boom"); } });
  assert.equal((await failing.narrate()).status, 502);
  const indirect = setup({ complete: async () => { throw Object.assign(new Error("no direct"), { code: "unsupported" }); } });
  assert.equal((await indirect.narrate()).status, 503);
  const h = setup();
  assert.equal((await h.narrate({ uptoSeq: 9 })).status, 400);
  assert.equal((await h.narrate({ lang: "../etc" })).status, 400);
  assert.equal((await h.call("POST", "/api/voice-mode/other")).handled, false);
});

test("helpers: request parsing, scrubbing, digest and remark cleanup", () => {
  assert.equal(parseNarrateRequest({ sessionId: "s", afterSeq: 1, uptoSeq: 900, kind: "actions", lang: "en" }), null, "span is bounded");
  assert.equal(scrub("curl -H 'Authorization: Bearer sk-live-123' --token=xyz https://x"), "curl -H 'Authorization: … … https://x");
  assert.equal(narrationDigest([ev(1, "assistant/chunk", { text: "hi" })], "actions"), "");
  assert.equal(cleanRemark("“Reading the config.”"), "Reading the config.");
});

test("a paired phone reaches exactly the two narrator routes with its voice grant", () => {
  validateRemoteAccessPolicy("voice-mode", VOICE_MODE_REMOTE_ACCESS);
  const allowed = (method: string, path: string) => VOICE_MODE_REMOTE_ACCESS.http.some((rule) =>
    (rule.methods as readonly string[]).includes(method) && matchRemotePath(rule.path, path));
  assert.ok(VOICE_MODE_REMOTE_ACCESS.http.every((rule) => rule.capability === "dictation.use"));
  assert.equal(allowed("POST", "/api/voice-mode/narrate"), true);
  assert.equal(allowed("GET", "/api/voice-mode/narration"), true);
  assert.equal(allowed("GET", "/api/voice-mode/narrate"), false);
  assert.equal(allowed("POST", "/api/voice-mode/anything"), false);
});
