import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import {
  assistFreshnessSeq,
  latestCompletedExchange,
  recentCompletedConversationContext,
  renderConversationContext,
} from "../src/nextAction.ts";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, ignorable = false): SessionEvent => {
  seq += 1;
  return { id: `e${seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1, ...(ignorable ? { ignorable } : {}) } as unknown as SessionEvent;
};
const reset = () => { seq = 0; };

const user = (text: string, extra: Record<string, unknown> = {}) => ev("user/message", { text, ...extra });
const assistant = (text: string) => ev("assistant/message", { text });
const turn = (turnId: string) => [ev("turn/started", { turnId }, true)];
const done = (turnId: string) => ev("turn/stopped", { turnId, reason: "completed" }, true);

test("assist freshness ignores post-turn bookkeeping but tracks real conversation movement", () => {
  reset();
  const events = [
    user("fix it"),
    ...turn("t1"),
    assistant("fixed"),
    done("t1"),
  ];
  const completedSeq = events.at(-1)!.seq;

  events.push(
    ev("usage/recorded", { tokens: { input: 1, output: 1 } }, true),
    ev("goal/audit", { verdict: "done" }, true),
    ev("session/metadata-changed", { title: "Fixed it" }, true),
    ev("isolation/status", { state: "merge-ready" }, true),
  );
  assert.equal(assistFreshnessSeq(events), completedSeq);

  const nextTurn = ev("turn/started", { turnId: "t2" }, true);
  events.push(nextTurn);
  assert.equal(assistFreshnessSeq(events), nextTurn.seq);

  const visible = user("one more thing");
  events.push(visible);
  assert.equal(assistFreshnessSeq(events), visible.seq);
});

test("context keeps the recent completed exchanges, oldest first", () => {
  reset();
  const events = [
    user("one"), assistant("answer one"),
    user("two"), assistant("answer two"),
    user("three"), ...turn("t"), assistant("answer three"), done("t"),
  ];
  const context = recentCompletedConversationContext(events);
  assert.deepEqual(context.map((x) => x.user), ["one", "two", "three"]);
  assert.deepEqual(context.map((x) => x.assistant), ["answer one", "answer two", "answer three"]);
});

test("context is bounded by exchange count, dropping the oldest", () => {
  reset();
  const events = [
    user("one"), assistant("a1"),
    user("two"), assistant("a2"),
    user("three"), assistant("a3"),
    user("four"), ...turn("t"), assistant("a4"), done("t"),
  ];
  assert.deepEqual(
    recentCompletedConversationContext(events).map((x) => x.user),
    ["two", "three", "four"],
    "the default keeps three exchanges",
  );
  assert.deepEqual(
    recentCompletedConversationContext(events, { maxExchanges: 2 }).map((x) => x.user),
    ["three", "four"],
  );
});

test("context is bounded by characters but never drops the newest exchange", () => {
  reset();
  const big = "x".repeat(5_000);
  const events = [
    user(`old ${big}`), assistant(big),
    user(`mid ${big}`), assistant(big),
    user(`new ${big}`), ...turn("t"), assistant(big), done("t"),
  ];
  const context = recentCompletedConversationContext(events, { maxChars: 12_000 });
  assert.equal(context.length, 1);
  assert.ok(context[0]!.user.startsWith("new "), "recent intent is what survives the budget");

  const single = recentCompletedConversationContext(events, { maxChars: 10 });
  assert.equal(single.length, 1, "the newest exchange is kept even when it alone exceeds the budget");
});

test("context is empty when no turn has completed, and matches the single-exchange selector", () => {
  reset();
  assert.deepEqual(recentCompletedConversationContext([]), []);

  reset();
  const inProgress = [user("one"), assistant("a1"), user("two"), ...turn("t")];
  assert.equal(latestCompletedExchange(inProgress), null);
  assert.deepEqual(recentCompletedConversationContext(inProgress), []);

  reset();
  const events = [user("one"), assistant("a1"), user("two"), ...turn("t"), assistant("a2"), done("t")];
  const newest = recentCompletedConversationContext(events).at(-1);
  assert.equal(newest?.assistantSeq, latestCompletedExchange(events)?.assistantSeq);
});

test("attachments appear as descriptors, never as content", () => {
  reset();
  const events = [
    user("look at this", {
      attachments: [
        { name: "screenshot.png", mime: "image/png", data: "SECRET-BYTES" },
        { path: "src/app.ts" },
        "not an object",
      ],
    }),
    ...turn("t"), assistant("I see the overflow."), done("t"),
  ];
  const context = recentCompletedConversationContext(events);
  assert.deepEqual(context[0]!.attachments, ["screenshot.png (image/png)", "src/app.ts"]);
  const rendered = renderConversationContext(context);
  assert.match(rendered, /\(attached: screenshot\.png \(image\/png\), src\/app\.ts\)/);
  assert.doesNotMatch(rendered, /SECRET-BYTES/);
});

test("the same log always produces the same context", () => {
  reset();
  const events = [user("one"), assistant("a1"), user("two"), ...turn("t"), assistant("a2"), done("t")];
  assert.deepEqual(
    recentCompletedConversationContext(events),
    recentCompletedConversationContext(events),
  );
});
