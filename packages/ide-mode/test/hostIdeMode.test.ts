import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { IDE_PROFILE as profile } from "../src/index.ts";
import { resolveWorkbenchShellPresentation } from "../../../apps/web/src/workbench/profileNavigation.ts";
import { shellDirectionFor } from "../../../apps/web/src/shellDirection.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("IDE mode registers a primary focused profile laid out mirrored: Files, chat, then the sidebar", () => {
  assert.equal(profile.presentation.navigation, "primary");
  // Files keeps the active chat's edited files open (WorkbenchFilesHints).
  assert.equal(profile.presentation.openSessionEdits, true);
  assert.equal("sessionPurpose" in profile, false, "IDE chats are ordinary chats, not a separate lane");
  assert.equal("sidebarSide" in profile.presentation, false, "the mirrored hint replaces sidebarSide");
  // The ordinary focused split (chat primary, Files at the end) — the mirror
  // puts Files first on screen, so no exchanged template is needed.
  assert.deepEqual(
    profile.defaultLayout.surfaces.map(({ surface, region }) => [surface, region]),
    [["session", "primary"], ["files", "end"]],
  );
  assert.deepEqual(resolveWorkbenchShellPresentation({ ...profile, available: true }), {
    focused: true,
    projectsOnly: false,
    mirrored: true,
    splitSurfaces: ["session", "files"],
    // Files is the flexible column; chat a fixed-width companion; the sidebar
    // rests on the project rail below 1600px (automatic, never persisted).
    companionWidth: { min: 360, target: 440, max: 560 },
    sidebarRailBelow: 1600,
  });
});

test("legacy sidebarSide: \"end\" still means a mirrored shell", () => {
  const legacy = resolveWorkbenchShellPresentation({
    id: "legacy", label: "L", description: "", order: 1, available: true,
    presentation: { focused: true, sidebarSide: "end", splitSurfaces: ["session", "files"] },
  });
  assert.equal(legacy.mirrored, true);
});

test("the mirror flips frames, never content, in either document direction", () => {
  assert.deepEqual(shellDirectionFor(true, "ltr"), {
    mirrored: true, shell: "rtl", frameDir: "rtl", contentDir: "ltr", towardEnd: "left", towardStart: "right",
  });
  assert.deepEqual(shellDirectionFor(true, "rtl"), {
    mirrored: true, shell: "ltr", frameDir: "ltr", contentDir: "rtl", towardEnd: "right", towardStart: "left",
  });
  // Not mirrored: no attributes at all, so the ordinary shell is untouched.
  assert.deepEqual(shellDirectionFor(false, "ltr"), {
    mirrored: false, shell: "ltr", frameDir: undefined, contentDir: undefined, towardEnd: "right", towardStart: "left",
  });
});

test("the host mirrors through dir: one flip on .app-shell, the document direction back on content roots", async () => {
  const [app, css, sidebar, rail, moduleView] = await Promise.all([
    source("../../../apps/web/src/App.tsx"),
    source("../../../apps/web/src/styles.css"),
    source("../../../apps/web/src/components/Sidebar.tsx"),
    source("../../../apps/web/src/components/ContextRail.tsx"),
    source("../../../apps/web/src/components/ui/ModuleView.ts"),
  ]);
  assert.match(app, /data-shell-mirror=\{shellDirection\.mirrored \? "true" : undefined\}/);
  assert.match(app, /<div className="app-shell" dir=\{shellDirection\.frameDir\}>/);
  assert.match(app, /<div className="workspace" dir=\{shellDirection\.contentDir\}/);
  assert.match(sidebar, /className="sidebar-main-content" dir=\{shellDirection\.contentDir\}/);
  assert.match(rail, /dir=\{shellDirection\.contentDir\}/);
  assert.match(moduleView, /\.\.\.\(dir \? \{ dir \} : \{\}\)/);
  // No second layout for the mirror: the old end-side grid and border/handle
  // overrides are gone, and the frames are written logically.
  assert.doesNotMatch(css, /data-sidebar-side/);
  assert.match(css, /\.sidebar-resize \{\s*position: absolute; top: 0; inset-inline-end: -3px;/);
  assert.match(css, /\.rail-resize \{\s*position: absolute; inset-inline-start: -3px;/);
  // The split row is the shell's height: a long session list can no longer
  // stretch it and push Chat's composer out of the window.
  assert.match(css, /grid-template-rows: minmax\(0, 1fr\);/);
  // Dragging toward the content always widens the sidebar, on either side.
  assert.match(sidebar, /startWidth \+ sign \* \(ev\.clientX - startX\)/);
});
