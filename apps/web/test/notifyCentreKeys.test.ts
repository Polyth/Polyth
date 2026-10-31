// The in-page notifier pre/post-record behaviour: the local template spec uses
// the client's status vocabulary while the server keys on idle/failed, so the
// client aligns the key before looking up the centre record, and a record that
// lands over the WS inside the short window replaces the already-shown OS
// notification in place (same tag, no second sound) instead of adding a second
// one.
import test from "node:test";
import assert from "node:assert/strict";
import type { NotificationRecord } from "@polyth/contracts";
import { notificationCentre } from "../src/notificationCentre.ts";
import { showNative, transitionKey } from "../src/notify.ts";
import type { NotificationSpec } from "../src/notifications.ts";

const record = (over: Partial<NotificationRecord> & { id: string; key: string; body: string }): NotificationRecord => ({
  kind: "completed",
  sessionId: "s",
  projectId: "p",
  title: "Polyth — Session",
  ts: Date.now(),
  read: false,
  ...over,
});

class FakeNotification {
  static permission = "granted" as NotificationPermission;
  static instances: FakeNotification[] = [];
  static reset(): void { FakeNotification.instances = []; }
  onclick: (() => void) | null = null;
  title: string;
  options: Record<string, unknown>;
  constructor(title: string, options: Record<string, unknown> = {}) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
  close(): void {}
}

const spec = (over: Partial<NotificationSpec> & { key: string }): NotificationSpec => ({
  kind: "completed",
  sessionId: "s",
  title: "Session",
  body: "Session — finished",
  ...over,
});

function withFakeBrowser(run: () => void): void {
  const globals = globalThis as unknown as { Notification?: unknown; document?: unknown; window?: unknown };
  const prev = { Notification: globals.Notification, document: globals.document, window: globals.window };
  FakeNotification.reset();
  try {
    globals.Notification = FakeNotification;
    globals.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
    globals.window = { focus() {} };
    run();
  } finally {
    globals.Notification = prev.Notification;
    globals.document = prev.document;
    globals.window = prev.window;
  }
}

test("client keys align with the server's turn/subagent transition keys", () => {
  // The server never emits `finished`/`waiting`: an idle or waiting turn is
  // `…:turn:idle`, and the waiting-for-person record reuses that same key.
  assert.equal(transitionKey("s:turn:finished"), "s:turn:idle");
  assert.equal(transitionKey("s:turn:waiting"), "s:turn:idle");
  assert.equal(transitionKey("s:turn:idle"), "s:turn:idle");
  assert.equal(transitionKey("s:turn:failed"), "s:turn:failed");
  assert.equal(transitionKey("child:subagent:finished"), "child:subagent:idle");
  assert.equal(transitionKey("child:subagent:waiting"), "child:subagent:idle");
  assert.equal(transitionKey("child:subagent:failed"), "child:subagent:failed");
  // Keys with no server counterpart stay untouched.
  assert.equal(transitionKey("s:question:2"), "s:question:2");
  assert.equal(transitionKey("s:permission:1"), "s:permission:1");
});

test("a centre record already present supplies the body and the shared tag", () => {
  notificationCentre.append(record({
    id: "rec-before-1",
    key: "rec-before:turn:idle",
    sessionId: "rec-before",
    body: "The record's own concrete reply.",
  }));
  withFakeBrowser(() => {
    showNative(spec({ key: "rec-before:turn:finished", sessionId: "rec-before", body: "Template body" }));
    assert.equal(FakeNotification.instances.length, 1, "one notification");
    assert.equal(FakeNotification.instances[0]!.options.body, "The record's own concrete reply.");
    assert.equal(FakeNotification.instances[0]!.options.tag, "polyth-rec-before:turn:idle");
    assert.equal(FakeNotification.instances[0]!.options.silent, undefined, "the first show still sounds");
  });
});

test("a record landing after the local template replaces it once, in place and silently", async () => {
  withFakeBrowser(() => {
    showNative(spec({ key: "late-record:turn:waiting", sessionId: "late-record", body: "Waiting template" }));
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0]!.options.body, "Waiting template");
    assert.equal(FakeNotification.instances[0]!.options.silent, undefined);

    notificationCentre.append(record({
      id: "rec-late-1",
      key: "late-record:turn:idle",
      sessionId: "late-record",
      body: "Now here is the reply.",
    }));
    assert.equal(FakeNotification.instances.length, 2, "the template is replaced in place, not duplicated");
    const replacement = FakeNotification.instances[1]!;
    assert.equal(replacement.options.body, "Now here is the reply.");
    assert.equal(replacement.options.tag, FakeNotification.instances[0]!.options.tag, "same tag");
    assert.equal(replacement.options.silent, true, "no second sound");

    // A second record for the same transition must not re-show anything.
    notificationCentre.append(record({
      id: "rec-late-2",
      key: "late-record:turn:idle",
      sessionId: "late-record",
      body: "A duplicate record.",
    }));
    assert.equal(FakeNotification.instances.length, 2, "one replacement at most");
  });
  await new Promise((r) => setTimeout(r, 0));
});

test("a subagent transition uses the child's key and is replaced by the child's record", () => {
  withFakeBrowser(() => {
    showNative(spec({
      key: "child-9:subagent:finished",
      kind: "subagent",
      sessionId: "parent",
      title: "Parent",
      body: "Parent — delegated agent finished",
    }));
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0]!.options.tag, "polyth-child-9:subagent:idle");

    notificationCentre.append(record({
      id: "rec-sub-1",
      key: "child-9:subagent:idle",
      sessionId: "parent",
      body: "Child task: Found 3 files.",
    }));
    assert.equal(FakeNotification.instances.length, 2);
    assert.equal(FakeNotification.instances[1]!.options.body, "Child task: Found 3 files.");
    assert.equal(FakeNotification.instances[1]!.options.tag, "polyth-child-9:subagent:idle");
  });
});

test("an unrelated record never replaces a shown template", () => {
  withFakeBrowser(() => {
    showNative(spec({ key: "unrelated:turn:finished", sessionId: "unrelated" }));
    notificationCentre.append(record({
      id: "rec-other-1",
      key: "someone-else:turn:idle",
      sessionId: "someone-else",
      body: "Not this transition.",
    }));
    assert.equal(FakeNotification.instances.length, 1, "no replacement for a different key");
  });
});

test("an earlier turn's record never supplies the text of a later transition of the same key", () => {
  const since = Date.now();
  notificationCentre.append(record({
    id: "rec-repeat-old",
    key: "repeat:turn:idle",
    sessionId: "repeat",
    body: "The previous turn's reply.",
    ts: since - 60_000,
  }));
  withFakeBrowser(() => {
    showNative(spec({ key: "repeat:turn:finished", sessionId: "repeat", body: "Template body", since }));
    assert.equal(FakeNotification.instances.length, 1);
    assert.equal(FakeNotification.instances[0]!.options.body, "Template body", "the older row is not this transition's");

    notificationCentre.append(record({
      id: "rec-repeat-new",
      key: "repeat:turn:idle",
      sessionId: "repeat",
      body: "This turn's reply.",
      ts: since + 5,
    }));
    assert.equal(FakeNotification.instances.length, 2, "this transition's record replaces the template");
    assert.equal(FakeNotification.instances[1]!.options.body, "This turn's reply.");
    assert.equal(FakeNotification.instances[1]!.options.silent, true);
  });
});
