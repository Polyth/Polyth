import test from "node:test";
import assert from "node:assert/strict";
import { resolveWorkbenchShellPresentation } from "../src/workbench/profileNavigation.ts";
import type { WorkbenchProfileSummary } from "@polyth/web-sdk";

test("focused profile metadata resolves the host split contract", () => {
  const presentation = resolveWorkbenchShellPresentation({
    id: "playground",
    label: "Playground",
    description: "",
    order: 1,
    available: true,
    presentation: { focused: true, sidebar: "projects", splitSurfaces: ["session", "playground"] },
  } satisfies WorkbenchProfileSummary);

  assert.deepEqual(presentation, {
    focused: true,
    projectsOnly: true,
    mirrored: false,
    splitSurfaces: ["session", "playground"],
    // No size hints: Playground keeps the ratio dock and its own sidebar.
    companionWidth: null,
    sidebarRailBelow: null,
  });
});

test("size hints are focused-split only and validated as untrusted data", () => {
  const resolve = (presentation: Record<string, unknown>) => resolveWorkbenchShellPresentation({
    id: "p", label: "P", description: "", order: 1, available: true, presentation,
  });
  const hints = { companionWidth: { min: 360, target: 440, max: 560 }, sidebarRailBelow: 1600 };
  assert.deepEqual(resolve({ focused: true, ...hints }).companionWidth, hints.companionWidth);
  assert.equal(resolve({ focused: true, ...hints }).sidebarRailBelow, 1600);
  assert.equal(resolve(hints).companionWidth, null, "an unfocused profile gets no companion split");
  assert.equal(resolve(hints).sidebarRailBelow, null);
  assert.equal(resolve({ focused: true, sidebarRailBelow: 800 }).sidebarRailBelow, null, "never inside the compact shell");
  assert.equal(resolve({ focused: true, sidebarRailBelow: "1600" }).sidebarRailBelow, null);
  assert.equal(resolve({ focused: true, companionWidth: "wide" }).companionWidth, null);
});
