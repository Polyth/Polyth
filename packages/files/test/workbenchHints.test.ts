import test from "node:test";
import assert from "node:assert/strict";
import { bindFilesWorkbench, openSessionEdits } from "../widgets/workbenchHints.ts";

const profile = (presentation: Record<string, unknown>) => ({
  getActiveProfile: () => ({ id: "p", label: "P", description: "", order: 1, available: true, presentation }),
  subscribe: () => () => {},
});

test("Files follows a chat's edits in every profile unless the profile opts out", () => {
  assert.equal(openSessionEdits(), false, "no workbench bound yet: nothing to follow");
  const chat = bindFilesWorkbench(profile({}));
  assert.equal(openSessionEdits(), true, "Chat and Canvas follow edits too, not only IDE mode");
  chat();
  const ide = bindFilesWorkbench(profile({ openSessionEdits: true }));
  assert.equal(openSessionEdits(), true);
  ide();
  const optOut = bindFilesWorkbench(profile({ openSessionEdits: false }));
  assert.equal(openSessionEdits(), false, "a profile can still opt out");
  optOut();
});
