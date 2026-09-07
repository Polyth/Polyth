import test from "node:test";
import assert from "node:assert/strict";
import {
  clearPackageComposerActions,
  registerComposerActionDeliverer,
  requestComposerAction,
  takePendingComposerAction,
} from "../src/packages/sandbox/composerAction.ts";

test("composer actions target one surface runtime", () => {
  const main: string[] = [];
  const details: string[] = [];
  const dropMain = registerComposerActionDeliverer("pkg.one", "main", (actionId) => {
    main.push(actionId);
    return true;
  });
  const dropDetails = registerComposerActionDeliverer("pkg.one", "details", (actionId) => {
    details.push(actionId);
    return true;
  });
  requestComposerAction("pkg.one", "attach", "main");
  assert.deepEqual(main, ["attach"]);
  assert.deepEqual(details, []);
  dropMain();
  dropDetails();
});

test("queued composer actions are consumed only by the targeted surface", () => {
  requestComposerAction("pkg.two", "open", "main");
  assert.equal(takePendingComposerAction("pkg.two", "details"), undefined);
  assert.equal(takePendingComposerAction("pkg.two", "main"), "open");
  assert.equal(takePendingComposerAction("pkg.two", "main"), undefined);
});

test("force teardown clears queued composer actions for the package", () => {
  requestComposerAction("pkg.gone", "open", "main");
  clearPackageComposerActions("pkg.gone");
  assert.equal(takePendingComposerAction("pkg.gone", "main"), undefined);
});
