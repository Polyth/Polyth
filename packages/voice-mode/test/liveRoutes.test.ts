// The spoken-conversation lease: scope before anything, one person's own
// conversations only, a New chat that attaches to a conversation created just
// now, and a block that lapses when the browser stops renewing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRemotePath, type SpaceContext } from "@polyth/contracts";
import { validateRemoteAccessPolicy } from "../../server/src/remotePolicy.ts";
import {
  VOICE_LIVE_PATH,
  VOICE_LIVE_TTL_MS,
  VOICE_NEW_CHAT_MS,
  VOICE_TURN_BLOCK,
  createVoiceLive,
  parseVoiceLiveRequest,
} from "../src/liveRoutes.ts";
import { VOICE_MODE_REMOTE_ACCESS } from "../src/serverEntry.ts";

const space = (spaceId: string, userId = "u1") => ({ spaceId, userId }) as unknown as SpaceContext;

function setup() {
  let clock = 5_000_000;
  const sessions: Record<string, { spaceId: string; purpose?: string; createdAt: number }> = {
    s1: { spaceId: "space-a", createdAt: clock - 3_600_000 },
    s2: { spaceId: "space-a", createdAt: clock - 3_600_000 },
    people: { spaceId: "space-a", purpose: "conversation", createdAt: clock },
    foreign: { spaceId: "space-b", createdAt: clock },
  };
  const live = createVoiceLive({
    forSpace: (context) => ({
      sessions: {
        snapshot: async (sessionId: string) => {
          const found = sessions[sessionId];
          if (!found || found.spaceId !== (context as unknown as { spaceId: string }).spaceId) throw new Error("not found");
          return { id: sessionId, purpose: found.purpose, createdAt: found.createdAt } as never;
        },
      },
    }),
    now: () => clock,
  });
  const post = async (body: unknown, context = space("space-a"), method = "POST", path = VOICE_LIVE_PATH) => {
    let status = 0;
    let payload: unknown;
    const handled = await live.routes({
      path, method, space: context,
      body: async () => body,
      json(code: number, value: unknown) { status = code; payload = value; },
    } as never);
    return { handled, status, payload: payload as Record<string, unknown> };
  };
  /** `userId: null` is a send with no author (the default would hide `undefined`). */
  const block = (sessionId: string, userId: string | null = "u1", spaceId = "space-a") =>
    live.contributor({ space: space(spaceId, "system"), sessionId, projectId: "p1", userId: userId ?? undefined, worktreePath: undefined });
  return {
    live, post, block, sessions,
    tick: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

test("a spoken conversation's turns carry the voice block, for that person and conversation only", async () => {
  const h = setup();
  assert.equal(await h.block("s1"), "", "nothing is spoken yet");
  assert.deepEqual(await h.post({ sessionId: "s1", live: true }), { handled: true, status: 200, payload: { live: true, ttlMs: VOICE_LIVE_TTL_MS } });
  assert.equal(await h.block("s1"), VOICE_TURN_BLOCK);
  assert.match(VOICE_TURN_BLOCK, /^<polyth-voice>\n[\s\S]+\n<\/polyth-voice>$/, "one complete block");
  assert.ok(Buffer.byteLength(VOICE_TURN_BLOCK) < 800, "small: the turn-context budget is shared");
  assert.equal(await h.block("s2"), "", "another conversation of the same person is not spoken");
  assert.equal(await h.block("s1", "u2"), "", "another member's turn in it is theirs to mark");
  assert.equal(await h.block("s1", null), "", "a system send has no listener");
  assert.equal(await h.block("s1", "u1", "space-b"), "", "the same ids in another Space are another person");

  h.tick(VOICE_LIVE_TTL_MS - 1);
  assert.equal(await h.block("s1"), VOICE_TURN_BLOCK);
  h.tick(2);
  assert.equal(await h.block("s1"), "", "a lease that is not renewed lapses");

  await h.post({ sessionId: "s1", live: true });
  await h.post({ sessionId: "s1", live: false });
  assert.equal(await h.block("s1"), "", "ending voice mode (or going silent) drops it at once");
});

test("scope comes first: a foreign or missing conversation answers alike and holds nothing", async () => {
  const h = setup();
  const foreign = await h.post({ sessionId: "foreign", live: true });
  const missing = await h.post({ sessionId: "nope", live: true });
  assert.deepEqual(foreign, missing);
  assert.equal(foreign.status, 404);
  assert.equal(await h.block("foreign"), "");
  assert.equal(await h.block("foreign", "u1", "space-b"), "", "…and it did not mark the other Space's conversation");
  assert.equal((await h.post({ sessionId: "people", live: true })).status, 404, "a people-only chat has no agent to tell");
  assert.equal((await h.post({ live: true, sessionId: 7 })).status, 400);
  assert.equal((await h.post({ sessionId: "s1" })).status, 400);
  assert.equal((await h.post({ sessionId: "s1", live: true }, space("space-a"), "GET")).handled, false);
  assert.equal((await h.post({ sessionId: "s1", live: true }, space("space-a"), "POST", "/api/voice-mode/other")).handled, false);
  assert.deepEqual(parseVoiceLiveRequest({ live: true }), { sessionId: null, live: true });
  assert.equal(parseVoiceLiveRequest({ sessionId: "x".repeat(201), live: true }), null);
});

test("a New chat's lease attaches to a conversation created just now, once", async () => {
  const h = setup();
  await h.post({ sessionId: null, live: true });
  assert.equal(await h.block("s1"), "", "an older conversation the person also writes in is not the spoken one");
  h.sessions.fresh = { spaceId: "space-a", createdAt: h.now() };
  h.sessions.later = { spaceId: "space-a", createdAt: h.now() };
  assert.equal(await h.block("fresh"), VOICE_TURN_BLOCK, "the first message of the new conversation is spoken");
  assert.equal(await h.block("later"), "", "the lease moved to that conversation; it does not mark a second one");
  assert.equal(await h.block("fresh"), VOICE_TURN_BLOCK);

  const stale = setup();
  await stale.post({ sessionId: null, live: true });
  stale.sessions.old = { spaceId: "space-a", createdAt: stale.now() - VOICE_NEW_CHAT_MS - 1 };
  assert.equal(await stale.block("old"), "");

  const pinned = setup();
  await pinned.post({ sessionId: null, live: true });
  await pinned.post({ sessionId: "s1", live: true });
  pinned.sessions.fresh = { spaceId: "space-a", createdAt: pinned.now() };
  assert.equal(await pinned.block("fresh"), "", "once the browser names the conversation, the open lease is gone");
  assert.equal(await pinned.block("s1"), VOICE_TURN_BLOCK);
});

test("leases are bounded per person, and disposing forgets them", async () => {
  const h = setup();
  for (let index = 0; index < 8; index++) {
    h.sessions[`n${index}`] = { spaceId: "space-a", createdAt: h.now() };
    assert.equal((await h.post({ sessionId: `n${index}`, live: true })).status, 200);
  }
  assert.equal((await h.post({ sessionId: "s1", live: true })).status, 429);
  assert.equal((await h.post({ sessionId: "n0", live: true })).status, 200, "renewing one already held is not a new lease");
  h.tick(VOICE_LIVE_TTL_MS + 1);
  assert.equal((await h.post({ sessionId: "s1", live: true })).status, 200, "lapsed leases make room");
  h.live.dispose();
  assert.equal(await h.block("s1"), "");
});

test("a paired phone may mark its spoken conversation with the voice grant it already has", () => {
  validateRemoteAccessPolicy("voice-mode", VOICE_MODE_REMOTE_ACCESS);
  const rule = VOICE_MODE_REMOTE_ACCESS.http.find((entry) => matchRemotePath(entry.path, VOICE_LIVE_PATH));
  assert.deepEqual(rule && { methods: [...rule.methods], capability: rule.capability, mutation: rule.mutation },
    { methods: ["POST"], capability: "dictation.use", mutation: true });
});
