// Host side of the generic composer contribution seam: ordering, replacement
// and disposal of package Add-menu items and paste handlers.
import test from "node:test";
import assert from "node:assert/strict";
import type { ComposerAddMenuItem, ComposerPasteHandler, ComposerSessionCreatedHook } from "@polyth/web-sdk";
import {
  composerContributionsVersion,
  listComposerAddMenuItems,
  listComposerPasteHandlers,
  listComposerSessionCreatedHooks,
  registerComposerAddMenuItem,
  registerComposerPasteHandler,
  registerComposerSessionCreatedHook,
  runComposerSessionCreatedHooks,
  subscribeComposerContributions,
} from "../src/composer/contributions.ts";

const item = (id: string, order: number): ComposerAddMenuItem => ({
  id,
  label: id,
  order,
  activate: () => {},
});

const handler = (id: string): ComposerPasteHandler => ({
  id,
  match: () => true,
  handle: async () => true,
});

test("add-menu contributions are listed by order then id and unregister cleanly", () => {
  const offB = registerComposerAddMenuItem(item("b", 20));
  const offA = registerComposerAddMenuItem(item("a", 10));
  const offC = registerComposerAddMenuItem(item("c", 10));
  assert.deepEqual(listComposerAddMenuItems().map((entry) => entry.id), ["a", "c", "b"]);
  offA();
  assert.deepEqual(listComposerAddMenuItems().map((entry) => entry.id), ["c", "b"]);
  offB();
  offC();
  assert.deepEqual(listComposerAddMenuItems(), []);
});

test("a re-registered id replaces the item and the superseded unregister is a no-op", () => {
  const offFirst = registerComposerAddMenuItem(item("same", 5));
  const replacement = item("same", 5);
  const offReplacement = registerComposerAddMenuItem(replacement);
  assert.equal(listComposerAddMenuItems().find((entry) => entry.id === "same"), replacement);
  offFirst();
  assert.equal(listComposerAddMenuItems().find((entry) => entry.id === "same"), replacement);
  offReplacement();
  assert.deepEqual(listComposerAddMenuItems(), []);
});

test("paste handlers keep registration order and replace by id", () => {
  const offFirst = registerComposerPasteHandler(handler("first"));
  const offSecond = registerComposerPasteHandler(handler("second"));
  assert.deepEqual(listComposerPasteHandlers().map((entry) => entry.id), ["first", "second"]);
  const replacement = handler("first");
  const offReplacement = registerComposerPasteHandler(replacement);
  assert.equal(listComposerPasteHandlers().find((entry) => entry.id === "first"), replacement);
  offFirst(); // superseded: must not remove the replacement
  assert.equal(listComposerPasteHandlers().find((entry) => entry.id === "first"), replacement);
  offReplacement();
  offSecond();
  assert.deepEqual(listComposerPasteHandlers(), []);
});

test("subscribers are notified on registration change and stop after disposal", () => {
  let notifications = 0;
  const off = subscribeComposerContributions(() => { notifications += 1; });
  const before = composerContributionsVersion();
  const remove = registerComposerAddMenuItem(item("notify", 1));
  assert.equal(notifications, 1);
  assert.ok(composerContributionsVersion() > before);
  remove();
  assert.equal(notifications, 2);
  off();
  registerComposerAddMenuItem(item("silent", 2))();
  assert.equal(notifications, 2);
});

test("session-created hooks run in registration order and stop at the first rejection", async () => {
  const calls: string[] = [];
  const hook = (id: string, fail = false): ComposerSessionCreatedHook => ({
    id,
    run: async (context) => {
      calls.push(`${id}:${context.sessionId}:${context.text}`);
      if (fail) throw new Error(`${id} failed`);
    },
  });
  const offFirst = registerComposerSessionCreatedHook(hook("first"));
  const offSecond = registerComposerSessionCreatedHook(hook("second", true));
  const offThird = registerComposerSessionCreatedHook(hook("third"));
  assert.deepEqual(listComposerSessionCreatedHooks().map((entry) => entry.id), ["first", "second", "third"]);
  await assert.rejects(
    runComposerSessionCreatedHooks({ projectId: "p1", sessionId: "s1", text: "hi" }),
    /second failed/,
  );
  assert.deepEqual(calls, ["first:s1:hi", "second:s1:hi"]);
  offFirst();
  offSecond();
  offThird();
  assert.deepEqual(listComposerSessionCreatedHooks(), []);
});

test("a re-registered session-created hook replaces the hook and its superseded unregister is a no-op", () => {
  const replacement = { id: "same", run: async () => {} } satisfies ComposerSessionCreatedHook;
  const offFirst = registerComposerSessionCreatedHook({ id: "same", run: async () => {} });
  const offReplacement = registerComposerSessionCreatedHook(replacement);
  assert.equal(listComposerSessionCreatedHooks().find((entry) => entry.id === "same"), replacement);
  offFirst();
  assert.equal(listComposerSessionCreatedHooks().find((entry) => entry.id === "same"), replacement);
  offReplacement();
  assert.deepEqual(listComposerSessionCreatedHooks(), []);
});
