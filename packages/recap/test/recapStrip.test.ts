// Which idle recap the strip may draw: only the latest word on an idle chat of
// this very log, never one a forked chat inherited, and a dismissal that
// survives a reload.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });

const { visibleRecap } = await import("../widgets/RecapStrip.tsx");
const { dismissRecap, recapDismissed, resetDismissedCacheForTests } = await import("../widgets/calloutDismissals.ts");

const event = (seq: number, type: string, ignorable = false): SessionEvent =>
  ({ id: `e${seq}`, sessionId: "s", seq, time: seq, type, data: {}, v: 1, ...(ignorable ? { ignorable: true } : {}) }) as SessionEvent;
const session = (atSeq: number, status: SessionProjection["status"] = "idle") =>
  ({ status, assist: { recap: "Fixed the queue.", atSeq, generatedAt: 1 } }) as Pick<SessionProjection, "status" | "assist">;

const quiet = [event(10, "user/message"), event(11, "assistant/message"), event(12, "turn/stopped", true), event(13, "usage/recorded", true)];

test("an idle chat shows its own recap through passive bookkeeping", () => {
  assert.equal(visibleRecap(session(12), quiet)?.recap, "Fixed the queue.");
});

test("new conversation activity or a running turn hides the recap", () => {
  assert.equal(visibleRecap(session(13), [...quiet, event(14, "user/message")]), null);
  assert.equal(visibleRecap(session(13, "working"), quiet), null);
});

test("a recap a fork copied from its parent (pinned past this log) is not shown", () => {
  // The parent's recap sat at seq 1845; the fork's own log is a few dozen events.
  const fork = [event(1, "session/created", true), event(12, "session/forked", true), event(35, "user/message"), event(40, "tool/started")];
  assert.equal(visibleRecap(session(1845), fork), null);
  assert.equal(visibleRecap(session(1845), []), null, "nothing loaded yet");
});

test("a dismissed recap stays closed after a reload; a newer one shows again", () => {
  dismissRecap("s", 12);
  resetDismissedCacheForTests();
  assert.equal(recapDismissed("s", 12), true);
  assert.equal(recapDismissed("s", 20), false);
  assert.equal(recapDismissed("other", 12), false);
});
