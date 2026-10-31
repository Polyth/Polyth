// Regression: the tablet band (styles.css) must read rail open/closed state
// from the semantic `.railbar-open` class (React `rail` state), never from
// `:has(.rail)`. A visited keep-alive surface stays in `keptSurfaces` after
// close — its `.rail` node lives on, merely hidden — so `.rail` presence is
// NOT "rail is open". This test pins that mounted != open across the full
// open -> close -> reopen -> switch -> close lifecycle.
import test from "node:test";
import assert from "node:assert/strict";
import { keptSurfaces, type RailSurface } from "../src/surfaces.ts";

const surface = (id: string, keepAlive: boolean): RailSurface => ({
  id,
  title: id,
  order: 0,
  component: () => null,
  presentation: keepAlive
    ? { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" }
    : undefined,
});

const files = surface("files", true);
const git = surface("git", true);
const context = surface("context", false); // contextual panel, not keep-alive
const all = [files, git, context];

// The host derives these two the same way ContextRail does.
const isOpen = (rail: string | null) => all.some((s) => s.id === rail);
const railClass = (rail: string | null) => (isOpen(rail) ? "railbar railbar-open" : "railbar");

test("keep-alive surface: mounted after close, but shell state is 'closed'", () => {
  let rail: string | null = null;
  const visited: string[] = [];
  const visit = (id: string) => { if (!visited.includes(id)) visited.push(id); };

  // 1. start — nothing mounted, shell reads closed
  assert.deepEqual(keptSurfaces(all, rail, visited), []);
  assert.equal(railClass(rail), "railbar");

  // 2. open Files (keep-alive)
  rail = "files"; visit("files");
  assert.deepEqual(keptSurfaces(all, rail, visited).map((s) => s.id), ["files"]);
  assert.equal(railClass(rail), "railbar railbar-open");

  // 3. close — Files STAYS mounted (keep-alive), but the shell is closed again.
  //    This is the exact case the PR's `:has(.rail)` guard got wrong.
  rail = null;
  assert.deepEqual(keptSurfaces(all, rail, visited).map((s) => s.id), ["files"], "Files node still mounted");
  assert.equal(railClass(rail), "railbar", "…yet the shell reads closed — the band reshape must return");

  // 4. reopen Files — same node, no remount
  rail = "files";
  assert.equal(railClass(rail), "railbar railbar-open");

  // 5. switch to Git — both keep-alive nodes now mounted
  rail = "git"; visit("git");
  assert.deepEqual(keptSurfaces(all, rail, visited).map((s) => s.id).sort(), ["files", "git"]);
  assert.equal(railClass(rail), "railbar railbar-open");

  // 6. close again — two nodes mounted, shell still reads closed
  rail = null;
  assert.deepEqual(keptSurfaces(all, rail, visited).map((s) => s.id).sort(), ["files", "git"]);
  assert.equal(railClass(rail), "railbar");
});

test("non-keep-alive contextual panel unmounts on close", () => {
  const visited = ["context"];
  assert.deepEqual(keptSurfaces(all, "context", visited).map((s) => s.id), ["context"]);
  // rail=null: nothing keeps it — `.rail` really is gone here, so either guard
  // would work for this kind. The keep-alive kinds are why the class is needed.
  assert.deepEqual(keptSurfaces(all, null, visited), []);
});
