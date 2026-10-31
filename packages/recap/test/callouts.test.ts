import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import {
  buildCalloutPrompt, extractCallouts, extractCalloutsFromText, latestTurnSources,
  mergeCallouts, parseCalloutReply, splitUnits, CALLOUT_ORDER, MAX_CALLOUTS,
} from "../src/callouts.ts";
import { promptRoutes } from "../src/promptRoutes.ts";

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent =>
  ({ id: `e${seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1 }) as SessionEvent;

const turn = (text: string): SessionEvent[] => [
  ev(1, "user/message", { text: "do it" }),
  ev(2, "turn/started", { turnId: "t" }),
  ev(3, "assistant/message", { text }),
  ev(4, "turn/stopped", { reason: "completed", turnId: "t" }),
];

test("heuristics classify each must-know kind and quote the source verbatim", () => {
  const text = [
    "I refactored the parser.",
    "- You need to restart the dev server before the change applies.",
    "Warning: this migration will delete the old column and cannot be undone.",
    "3 tests failed in the suite, so the build is not green.",
    "Which approach do you want for the cache layer?",
    "Set the API key in your environment; it is missing right now.",
  ].join("\n");
  const found = extractCalloutsFromText({ seq: 3, text });
  const kinds = new Map(found.map((c) => [c.kind, c.quote]));
  assert.deepEqual([...kinds.keys()].sort(), ["action", "credential", "decision", "failed-check", "risk"]);
  for (const callout of found) assert.ok(text.replace(/\*\*/g, "").replace(/\s+/g, " ").includes(callout.quote));
  assert.equal(found.some((c) => /refactored/.test(c.quote)), false, "plain narration is not a callout");
});

test("expected failures, zero counts, sign-offs and negations are not callouts", () => {
  const kindOf = (text: string) => extractCalloutsFromText({ seq: 1, text })[0]?.kind ?? null;
  // Each of these raised a false alarm before; the sentence it came from reads fine.
  for (const quiet of [
    "Quick mutation check: with the recap fallback removed, the new assertion should fail.",
    "The new test fails without the fix and passes with it.",
    "Implemented the webhook handler and the `orders` migration.",
    "0 failed, 120 passed.",
    "Fixed the failing test in `store.test.ts`.",
    "No breaking changes; the API is unchanged.",
    "Fixed the warning in the console.",
    "Let me know if you want anything else.",
    "You should now see the new button in the header.",
    "If you need to rotate the key, run `npm run rotate`.",
    "No API key is needed for local runs.",
    "No tests were skipped.",
    "xcode only calls `uuid.v4()` through CommonJS `require`, so it never touches the vulnerable v3/v5/v6 code.",
    "That resolves cleanly: xcode → uuid 11.1.1, and the audit finds 0 vulnerabilities.",
    "npm audit reports no high-severity vulnerabilities.",
  ]) assert.equal(kindOf(quiet), null, quiet);
  // An excused match still falls through to the next kind, and real alarms stay.
  assert.equal(kindOf("No tests failed, but you need to restart the dev server."), "action");
  assert.equal(kindOf("I fixed the parser but the build still fails on Windows."), "failed-check");
  assert.equal(kindOf("I did not run the e2e tests because Playwright is not installed."), "unverified");
  assert.equal(kindOf("The Safari layout is not verified on a real device."), "unverified");
  assert.equal(kindOf("Let me know if you want the old route kept or removed."), "decision");
  assert.equal(kindOf("Want me to also update the docs?"), "decision");
  assert.equal(kindOf("This is a breaking change for plugin authors."), "risk");
  assert.equal(kindOf("npm audit still finds 2 vulnerabilities in `uuid`."), "risk");
  assert.equal(kindOf("The form input is not escaped, so the page stays vulnerable to XSS."), "risk");
});

test("code fences are ignored and nothing is invented for quiet turns", () => {
  assert.deepEqual(extractCalloutsFromText({ seq: 1, text: "```\nwarning: you must restart\n```\nAll done and working." }), []);
  assert.deepEqual(extractCallouts(turn("Everything is finished and passes.")).callouts, []);
});

test("only a completed turn after the last user message is read", () => {
  assert.deepEqual(latestTurnSources([ev(1, "user/message"), ev(2, "assistant/message", { text: "Warning: unsafe." })]), []);
  const events = [...turn("Warning: old turn is dangerous."), ev(5, "user/message", { text: "next" }),
    ev(6, "assistant/message", { text: "You must rotate the token." }), ev(7, "turn/stopped", { reason: "completed" })];
  const { atSeq, callouts } = extractCallouts(events);
  assert.equal(atSeq, 6);
  assert.deepEqual(callouts.map((c) => c.seq), [6]);
});

test("callouts are ranked, deduped and capped", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `Warning: risky operation number ${i} may delete data.`);
  const text = ["You should review this change carefully.", ...lines, lines[0]!].join("\n");
  const { callouts } = extractCallouts(turn(text));
  assert.equal(callouts.length, MAX_CALLOUTS);
  assert.deepEqual(CALLOUT_ORDER.slice(0, 2), ["decision", "failed-check"], "what blocks the agent comes first");
  assert.equal(callouts[0]!.kind, "action", "a step for the person outranks a risk to know about");
  assert.equal(callouts[1]!.kind, "risk");
  assert.equal(new Set(callouts.map((c) => c.quote)).size, callouts.length);
});

test("model replies keep only verbatim quotes of the cited message", () => {
  const sources = [{ seq: 3, text: "Deploys need your **manual approval** in the console first." }];
  assert.match(buildCalloutPrompt(sources), /\[#3\]/);
  const reply = [
    "action | 3 | Deploys need your manual approval in the console first.",
    "risk | 3 | The database will be wiped.",
    "risk | 9 | Deploys need your manual approval in the console first.",
    "bogus | 3 | Deploys need your manual approval",
    "action | 3 | short",
  ].join("\n");
  const parsed = parseCalloutReply(reply, sources);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.source, "model");
  assert.equal(parseCalloutReply("none", sources).length, 0);
  const heuristic = extractCalloutsFromText({ seq: 3, text: sources[0]!.text });
  assert.equal(mergeCallouts(heuristic, parsed).length, Math.max(heuristic.length, 1), "overlapping quotes are not duplicated");
});

test("callout route validates the session first and only runs on explicit POST", async () => {
  let generated = 0;
  const routes = promptRoutes({
    projection: async (_space, id) => (id === "s1" ? ({ id } as never) : undefined),
    callouts: async () => { generated += 1; return { callouts: [], atSeq: 4 }; },
  });
  const call = async (path: string, method = "POST") => {
    let status = 0; let body: unknown;
    const handled = await routes({
      path, method, space: {} as never, body: async () => ({}),
      json: (s: number, b: unknown) => { status = s; body = b; },
    } as never);
    return { handled, status, body };
  };
  assert.equal((await call("/api/sessions/nope/assist/callouts")).status, 404);
  assert.equal(generated, 0);
  assert.equal((await call("/api/sessions/s1/assist/callouts", "GET")).handled, false);
  assert.deepEqual((await call("/api/sessions/s1/assist/callouts")).body, { callouts: [], atSeq: 4 });
  assert.equal(generated, 1);
  const unavailable = promptRoutes({ projection: async () => ({}) as never });
  let status = 0;
  await unavailable({ path: "/api/sessions/s1/assist/callouts", method: "POST", space: {} as never, body: async () => ({}), json: (s: number) => { status = s; } } as never);
  assert.equal(status, 503);
});

test("splitUnits splits sentences without a regex lookbehind (WebKit < 16.4 cannot parse one)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/callouts.ts", import.meta.url), "utf8");
  assert.equal(/\(\?<[=!]/.test(source.replace(/^\s*\/\/.*$/gm, "")), false);
  assert.deepEqual(
    splitUnits("First sentence is long enough. Second sentence is long enough! third stays attached to the second."),
    ["First sentence is long enough.", "Second sentence is long enough! third stays attached to the second."],
  );
});
