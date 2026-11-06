import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Project } from "@polyth/contracts";
import {
  claimPersonalProjectAttempt,
  isPersonalProject,
  resetPersonalProjectAttemptForTest,
  soloPersonalProject,
} from "../src/personalProject.ts";
import {
  BUILTIN_STARTERS,
  EMPTY_STARTER_CONTEXT,
  STARTER_PREFS_DEFAULTS,
  contextualStarterIds,
  isPlainFolder,
  starterCategories,
  starterContextFrom,
  starterFitsProject,
} from "../src/starters.ts";

const src = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

const personal: Project = { id: "p", path: "/data/spaces/home/personal/abc", name: "Personal", createdAt: 1, personal: true };
const work: Project = { id: "w", path: "/work", name: "Work", createdAt: 2 };

test("the shell is projectless only while the personal project is the sole project", () => {
  assert.equal(isPersonalProject(personal), true);
  assert.equal(isPersonalProject(work), false);
  assert.equal(isPersonalProject(null), false);
  assert.equal(soloPersonalProject([personal]), personal);
  assert.equal(soloPersonalProject([personal, work]), null, "a real project brings project chrome back");
  assert.equal(soloPersonalProject([work]), null);
  assert.equal(soloPersonalProject([]), null);
});

test("the first-run request is attempted once per document", () => {
  resetPersonalProjectAttemptForTest();
  assert.equal(claimPersonalProjectAttempt(), true);
  assert.equal(claimPersonalProjectAttempt(), false, "a refusal falls back to the picker instead of retrying");
  resetPersonalProjectAttemptForTest();
});

test("the personal project suggests everyday starters, not codebase work", () => {
  const ids = contextualStarterIds({ ...EMPTY_STARTER_CONTEXT, personal: true });
  assert.deepEqual(ids.slice(0, 2), ["builtin:research-question", "builtin:weigh-options"]);
  for (const id of ids) {
    const starter = BUILTIN_STARTERS.find((candidate) => candidate.id === id)!;
    assert.ok(!starter.directions?.includes("engineering"), `${id} is not a code starter`);
  }
  // Ordinary General projects keep every built-in, as before.
  assert.ok(contextualStarterIds(EMPTY_STARTER_CONTEXT).includes("builtin:explore"));
  const explore = BUILTIN_STARTERS.find((candidate) => candidate.id === "builtin:explore")!;
  assert.equal(starterFitsProject(explore, undefined), true);
  assert.equal(starterFitsProject(explore, undefined, true), false);
});

test("a General project outside Git suggests the same everyday starters", () => {
  const notRepo = { isRepo: false, staged: [], unstaged: [], untracked: [], conflicted: [], ahead: 0 };
  const session = { hasHistory: false, lastTurnFinished: false };
  const plain = starterContextFrom(notRepo, session);
  assert.equal(plain.repository, false);
  assert.deepEqual(contextualStarterIds(plain), contextualStarterIds({ ...EMPTY_STARTER_CONTEXT, personal: true }));
  // The picker lists every built-in, everyday ones first; code ones stay pinnable below.
  const builtIn = starterCategories(STARTER_PREFS_DEFAULTS, plain).find((group) => group.starters.length === BUILTIN_STARTERS.length)!;
  assert.deepEqual(
    builtIn.starters.slice(0, 4).map((starter) => starter.id).sort(),
    ["builtin:continue", "builtin:research-question", "builtin:review-result", "builtin:weigh-options"],
  );

  // A repository, or status not known yet, keeps every built-in.
  const repo = starterContextFrom({ ...notRepo, isRepo: true }, session);
  assert.equal(repo.repository, undefined);
  assert.ok(contextualStarterIds(repo).includes("builtin:explore"));
  assert.ok(contextualStarterIds(starterContextFrom(null, session)).includes("builtin:explore"));

  // Directions still decide: engineering keeps code work, research its own leads.
  const engineering = { ...plain, directions: ["engineering"] as const };
  assert.equal(isPlainFolder(engineering), false);
  assert.equal(contextualStarterIds(engineering)[0], "builtin:explore");
  assert.deepEqual(contextualStarterIds({ ...plain, directions: ["research"] }).slice(0, 2), ["builtin:research-question", "builtin:summarize-sources"]);
});

test("an empty registry starts in the personal project before the folder picker", async () => {
  const init = await src("init.ts");
  const refresh = init.slice(init.indexOf("export async function refreshProjects"), init.indexOf("async function startPersonalProject"));
  const recovery = refresh.indexOf("scheduleProjectRecovery()");
  const personalStart = refresh.indexOf("projects = await startPersonalProject()");
  const publish = refresh.indexOf("store.publishProjectList(ticket, projects)");
  assert.ok(recovery > 0 && personalStart > recovery, "a transient empty list during recovery is not a first run");
  assert.ok(publish > personalStart, "the registry stays loading while the personal project is created, so the picker never flashes");
  assert.match(init, /claimPersonalProjectAttempt\(\)/);
  assert.match(init, /api\.ensurePersonalProject\(tr\("personalproject\.name"\)\)/);
});

test("project chrome hides while only the personal project exists", async () => {
  const composer = await src("components/Composer.tsx");
  assert.match(composer, /!soloPersonal && heroChrome\.location && \(\s*<SessionContextBar/,
    "no project or checkout picker above the composer");
  const sidebar = await src("components/Sidebar.tsx");
  assert.match(sidebar, /\(soloPersonal \? \[\] : arrangedOrder\(orderedProjects\)\)\.map/, "no project icon on the rail");
  assert.match(sidebar, /showFocusedProject = focusedProject !== null && !railSearchOpen && !soloPersonal/, "no project header row");
  const hero = await src("components/workspace/builtinSurfaces.tsx");
  assert.match(hero, /isPersonalProject\(project\)\s*\n\s*\/\/[^\n]*\n\s*\? <h2>\{tr\("personalproject\.greeting"\)\}<\/h2>/,
    "the greeting does not name a project the person never chose");
});
