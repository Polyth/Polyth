import test from "node:test";
import assert from "node:assert/strict";
import { listProjectSettings, registerProjectSettings, subscribeProjectSettings, openProjectSettings, subscribeProjectSettingsNavigation } from "../src/projectSettings.ts";

const contribution = (id: string, ownerPackageId?: string) => ({
  id,
  label: id,
  ownerPackageId,
  render: () => null,
});

test("project settings navigation carries the requested project and contribution and disposes", () => {
  const received: unknown[] = [];
  const off = subscribeProjectSettingsNavigation((request) => received.push(request));
  openProjectSettings("project-b", "files.repositories");
  off();
  openProjectSettings("project-a");
  assert.deepEqual(received, [{ projectId: "project-b", contributionId: "files.repositories" }]);
});

test("project settings contributions are ordered, visible by project, and disposed safely", () => {
  let updates = 0;
  const offUpdates = subscribeProjectSettings(() => { updates++; });
  const first = registerProjectSettings({ ...contribution("memory", "memory"), order: 20, visible: (projectId: string) => projectId === "project-a" }, "memory");
  const second = registerProjectSettings({ ...contribution("appearance", "host"), order: 10 }, "host");
  assert.deepEqual(listProjectSettings("project-a").map((entry) => entry.id), ["appearance", "memory"]);
  assert.deepEqual(listProjectSettings("project-b").map((entry) => entry.id), ["appearance"]);
  first();
  assert.deepEqual(listProjectSettings("project-a").map((entry) => entry.id), ["appearance"]);
  second();
  offUpdates();
  assert.ok(updates >= 4);
});

test("stale disposer cannot remove a same-owner replacement and owners cannot collide", () => {
  const first = registerProjectSettings(contribution("memory", "memory"), "memory");
  const replacement = registerProjectSettings({ ...contribution("memory", "memory"), label: "Replacement" }, "memory");
  assert.equal(listProjectSettings("project-a")[0]?.label, "Replacement");
  first();
  assert.equal(listProjectSettings("project-a")[0]?.label, "Replacement");
  assert.throws(() => registerProjectSettings(contribution("memory", "other"), "other"), /cannot replace/);
  replacement();
});
