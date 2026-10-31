import test from "node:test";
import assert from "node:assert/strict";
import { registerConversationReveal, requestConversationReveal, type ConversationRevealRequest } from "../src/conversationReveal.ts";

test("a reveal waits for the matching conversation mount and preserves finder focus", async () => {
  const request = requestConversationReveal("older-chat", 17, { focus: false });
  let wrongCalled = false;
  const wrong = registerConversationReveal("other-chat", () => { wrongCalled = true; return true; });
  const right = registerConversationReveal("older-chat", (target) => {
    assert.equal(target.eventSeq, 17);
    assert.equal(target.focus, false);
    target.finish(true);
    return true;
  });
  try { assert.equal(await request, true); assert.equal(wrongCalled, false); }
  finally { right(); wrong(); }
});

test("a newer result cancels an older navigation and only the new target can acknowledge", async () => {
  const seen: ConversationRevealRequest[] = [];
  const unregister = registerConversationReveal("chat", (request) => { seen.push(request); return true; });
  try {
    const old = requestConversationReveal("chat", 3);
    const next = requestConversationReveal("chat", 19);
    assert.equal(await old, false);
    assert.equal(seen[0]!.signal.aborted, true);
    seen[0]!.finish(true);
    seen[1]!.finish(true);
    assert.equal(await next, true);
  } finally { unregister(); }
});

test("scope change or caller cancellation cannot acknowledge a stale navigation", async () => {
  let target: ConversationRevealRequest | undefined;
  let current = true;
  const unregister = registerConversationReveal("chat", (request) => { target = request; return true; });
  try {
    const changed = requestConversationReveal("chat", 4, { current: () => current });
    current = false;
    target!.finish(true);
    assert.equal(await changed, false);
    const controller = new AbortController();
    const cancelled = requestConversationReveal("chat", 5, { signal: controller.signal });
    controller.abort();
    assert.equal(await cancelled, false);
    assert.equal(target!.signal.aborted, true);
    assert.equal(await requestConversationReveal("chat", 0), false);
  } finally { unregister(); }
});
