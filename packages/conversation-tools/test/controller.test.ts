import test from "node:test";
import assert from "node:assert/strict";
import { createFindController } from "../widgets/controller.ts";

test("find state stays activation-local and repeats request input focus", () => {
  const first = createFindController();
  const second = createFindController();
  let updates = 0;
  const unsubscribe = first.subscribe(() => { updates += 1; });
  first.open("session-a");
  const focus = first.getSnapshot()!.focus;
  first.open("session-a");
  assert.ok(first.getSnapshot()!.focus > focus);
  assert.equal(second.getSnapshot(), null);
  first.open("session-b");
  first.close();
  assert.equal(first.getSnapshot(), null);
  assert.equal(updates, 4);
  unsubscribe();
  first.open("session-c");
  assert.equal(updates, 4);
  first.dispose();
  assert.equal(first.getSnapshot(), null);
  assert.equal(createFindController().getSnapshot(), null);
});

test("only the longest-mounted dialog host is primary and the role is handed over", () => {
  const controller = createFindController();
  const a = {}; const b = {};
  const detachA = controller.attach(a);
  const detachB = controller.attach(b);
  assert.equal(controller.isPrimary(a), true);
  assert.equal(controller.isPrimary(b), false);
  detachA();
  assert.equal(controller.isPrimary(b), true);
  detachB();
  assert.equal(controller.isPrimary(b), false);
});
