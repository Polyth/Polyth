// Moved from apps/web/test/playgroundMode.test.ts: this half of the test is
// about the playground package's own UI and registration, so it lives with the
// package instead of naming it from the host.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("Playground is a split mode with project-rail navigation, immediate arming, and pane swap", async () => {
  const [app, sidebar, header, view, css, registration] = await Promise.all([
    source("../../../apps/web/src/App.tsx"),
    source("../../../apps/web/src/components/Sidebar.tsx"),
    source("../../../apps/web/src/components/HeaderViewTabs.tsx"),
    source("../widgets/PlaygroundView.tsx"),
    source("../../../apps/web/src/styles.css"),
    source("../widgets/index.tsx"),
  ]);

  assert.match(app, /useWorkbenchLayout/);
  assert.match(registration, /focused:\s*true/);
  assert.match(registration, /sidebar:\s*"projects"/);
  assert.match(registration, /splitSurfaces:\s*\["session", "playground"\]/);
  assert.match(app, /data-workspace-split/);
  assert.match(app, /focusedSwapped/);
  assert.match(sidebar, /effectiveViewMode = projectsOnly\s*\? "rail" as const/);
  assert.match(sidebar, /const collapsed = !compact && !projectsOnly && \(layout\.collapsed \|\| automaticRail\)/);
  assert.match(header, /focus-mode-trigger/);
  assert.match(view, /active === false/);
  // Work goes to the work chat through host APIs; no private session create.
  assert.doesNotMatch(view, /api\.createSession/);
  assert.match(view, /host\.conversation\.startNewSession\(projectId, \{/);
  assert.match(view, /swapSurfaces\("session", "playground"\)/);
  assert.doesNotMatch(view, /Enable agent|actionLabel=\{armed \? "Open chat" : "Enable Playground"\}/);
  assert.match(css, /grid-template-areas:\s*"sidebar workspace result"/);
  assert.match(css, /grid-template-areas:\s*"sidebar result workspace"/);
  assert.match(css, /grid-template-columns:\s*max-content max-content minmax\(0, 1fr\)/);
  assert.match(css, /workspace-focus-swap[\s\S]*?rail-resize/);
});
