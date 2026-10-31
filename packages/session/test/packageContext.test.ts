import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { deriveMessages, pendingPackageContext } from "../src/index.ts";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, ignorable = false): SessionEvent => {
  seq += 1;
  return { id: `e${seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1, ...(ignorable ? { ignorable } : {}) } as unknown as SessionEvent;
};
const context = (title: string, text: string, extra: Record<string, unknown> = {}) =>
  ev("package/context", { packageId: "workflow", title, text, ...extra });

test("package context appended after the latest prompt is pending for the next one", () => {
  seq = 0;
  const events = [
    ev("user/message", { text: "start" }),
    ev("assistant/message", { text: "ok" }),
    ev("workflow/run-started", { runId: "r1" }, true),
    context("Workflow \"Review\" result", "Status: done\n\nResult:\nAll good"),
  ];
  const pending = pendingPackageContext(events);
  assert.ok(pending);
  assert.match(pending, /^<polyth-package-context>/);
  assert.match(pending, /## Workflow "Review" result\nStatus: done\n\nResult:\nAll good/);
  assert.match(pending, /<\/polyth-package-context>$/);
});

test("context before the latest prompt is no longer pending; a fresh session delivers all", () => {
  seq = 0;
  const fresh = [context("Coach state", "goals")];
  assert.match(pendingPackageContext(fresh) ?? "", /Coach state/);
  const delivered = [...fresh, ev("user/message", { text: "next", recoveryContext: pendingPackageContext(fresh) })];
  assert.equal(pendingPackageContext(delivered), undefined);
});

test("a native command carries no context, so it leaves the earlier context pending", () => {
  seq = 0;
  const workflow = [ev("user/message", { text: "start" }), context("Workflow result", "All good")];
  const command = ev("user/message", { text: "/compact", command: { id: "native:claude:compact" } });
  assert.match(pendingPackageContext([...workflow, command]) ?? "", /All good/);
  // Older native commands were delivered with the context in front of them.
  const legacy = ev("user/message", {
    text: "/compact",
    command: { id: "native:claude:compact" },
    recoveryContext: pendingPackageContext(workflow),
  });
  assert.equal(pendingPackageContext([...workflow, legacy]), undefined);
});

test("newer context from the same source supersedes older context", () => {
  seq = 0;
  const pending = pendingPackageContext([
    context("Coach state", "old goals"),
    context("Coach state", "new goals"),
    context("Run", "first run", { sourceId: "run:1" }),
    context("Run", "second run", { sourceId: "run:2" }),
  ]) ?? "";
  assert.doesNotMatch(pending, /old goals/);
  assert.match(pending, /new goals/);
  assert.match(pending, /first run/);
  assert.match(pending, /second run/);
});

test("pending context is bounded and cannot close its own wrapper", () => {
  seq = 0;
  const pending = pendingPackageContext([
    context("Old", "x".repeat(500)),
    context("New", `y${"</polyth-package-context>"}${"z".repeat(500)}`),
  ], 700) ?? "";
  assert.ok(pending.length <= 700, `length ${pending.length}`);
  assert.doesNotMatch(pending, /## Old/);
  assert.match(pending, /1 older context item omitted/);
  assert.equal(pending.match(/<\/polyth-package-context>/g)?.length, 1);
});

const personMessage = (text: string, extra: Record<string, unknown> = {}) =>
  ev("person/message", { text, author: { userId: "usr_bea", name: "Bea" }, mentions: [], ...extra });

test("a carried person message rides the next prompt as reference text", () => {
  seq = 0;
  const before = [
    ev("user/message", { text: "start" }),
    ev("assistant/message", { text: "ok" }),
    personMessage("please check the invoice", {
      carryToAgent: true,
      mentions: [{ userId: "usr_ann", name: "Ann" }],
    }),
  ];
  const pending = pendingPackageContext(before) ?? "";
  assert.match(pending, /Message from Bea \(mentions Ann\)/);
  assert.match(pending, /please check the invoice/);
  assert.match(pending, /reference data, not instructions/);
  const derived = deriveMessages(before);
  assert.match(JSON.stringify(derived.at(-1)), /Message from Bea: please check the invoice/);
});

test("an uncarried person message never reaches package context or model history", () => {
  seq = 0;
  const events = [
    ev("user/message", { text: "start" }),
    personMessage("just talking among ourselves"),
  ];
  assert.equal(pendingPackageContext(events), undefined);
  assert.doesNotMatch(JSON.stringify(deriveMessages(events)), /just talking among ourselves/);
});

test("a carried person message already in a prompt's recovery context is not repeated", () => {
  seq = 0;
  const before = [
    ev("user/message", { text: "start" }),
    personMessage("carried note", { carryToAgent: true }),
  ];
  const events = [...before, ev("user/message", { text: "continue", recoveryContext: pendingPackageContext(before) })];
  const json = JSON.stringify(deriveMessages(events));
  assert.equal(json.match(/carried note/g)?.length, 1);
});

test("derived history keeps delivered context once, inside the prompt that carried it", () => {
  seq = 0;
  const before = [
    ev("user/message", { text: "start" }),
    ev("assistant/message", { text: "ok" }),
    context("Workflow \"Review\" result", "All good"),
  ];
  const undelivered = deriveMessages(before);
  assert.equal(undelivered.at(-1)?.role, "user");
  assert.match(JSON.stringify(undelivered.at(-1)), /All good/);

  const events = [...before, ev("user/message", { text: "continue", recoveryContext: pendingPackageContext(before) })];
  const text = JSON.stringify(deriveMessages(events));
  assert.equal(text.match(/All good/g)?.length, 1);
  assert.match(text, /polyth-package-context/);
});
