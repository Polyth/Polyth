import test from "node:test";
import assert from "node:assert/strict";
import {
  changesKey,
  collectSessionChanges,
  deletedChildren,
  deletedFolders,
  isVisibleWhenChangedOnly,
  relativeToRoots,
  rollupFolders,
  toolChangeKind,
} from "../widgets/editor/sessionChanges.ts";

const tool = (name: string, files: string[], extra: Record<string, unknown> = {}) =>
  ({ kind: "tool", tool: name, changedFiles: files, ...extra });
const user = (extra: Record<string, unknown> = {}) => ({ kind: "user", ...extra });

test("relativeToRoots strips roots, rejects outside absolutes and traversal", () => {
  assert.equal(relativeToRoots("/repo/src/a.ts", ["/repo"]), "src/a.ts");
  assert.equal(relativeToRoots("./src\\a.ts", []), "src/a.ts");
  assert.equal(relativeToRoots("/elsewhere/a.ts", ["/repo"]), null);
  assert.equal(relativeToRoots("../a.ts", []), null);
  assert.equal(relativeToRoots("/repo", ["/repo"]), null);
  assert.equal(relativeToRoots("/repo/sub/a.ts", ["/repo", "/repo/sub"]), "a.ts");
});

test("toolChangeKind distinguishes create/delete/modify", () => {
  assert.equal(toolChangeKind("create_file"), "created");
  assert.equal(toolChangeKind("delete_file"), "deleted");
  assert.equal(toolChangeKind("StrReplace"), "modified");
  assert.equal(toolChangeKind(undefined), "modified");
});

test("collects tool edits, skipping undone and errored calls", () => {
  const changes = collectSessionChanges([
    user(),
    tool("Edit", ["/repo/a.ts"]),
    tool("Edit", ["b.ts"], { undone: true }),
    tool("Edit", ["c.ts"], { status: "error" }),
    { kind: "assistant" },
  ], ["/repo"]);
  assert.deepEqual([...changes.keys()], ["a.ts"]);
});

test("latestTurn marks only edits after the last user message", () => {
  const changes = collectSessionChanges([
    user(), tool("Edit", ["old.ts"]),
    user(), tool("Edit", ["new.ts"]),
  ], []);
  assert.equal(changes.get("old.ts")?.latestTurn, false);
  assert.equal(changes.get("new.ts")?.latestTurn, true);
  // Touching an old file again in the latest turn refreshes recency.
  const again = collectSessionChanges([user(), tool("Edit", ["a.ts"]), user(), tool("Edit", ["a.ts"])], []);
  assert.equal(again.get("a.ts")?.latestTurn, true);
});

test("kind merging: created stays created, delete wins, recreate becomes modified", () => {
  const changes = collectSessionChanges([
    tool("create_file", ["n.ts"]), tool("Edit", ["n.ts"]),
    tool("Edit", ["d.ts"]), tool("delete_file", ["d.ts"]),
    tool("delete_file", ["r.ts"]), tool("create_file", ["r.ts"]),
  ], []);
  assert.equal(changes.get("n.ts")?.kind, "created");
  assert.equal(changes.get("d.ts")?.kind, "deleted");
  assert.equal(changes.get("r.ts")?.kind, "modified");
});

test("git refines kind but never adds paths the session did not touch", () => {
  const changes = collectSessionChanges(
    [tool("Write", ["new.ts", "gone.ts"])],
    [],
    [
      { path: "new.ts", status: "untracked" },
      { path: "gone.ts", status: "deleted" },
      { path: "unrelated.ts", status: "modified" },
    ],
  );
  assert.equal(changes.get("new.ts")?.kind, "created");
  assert.equal(changes.get("gone.ts")?.kind, "deleted");
  assert.equal(changes.has("unrelated.ts"), false);
});

test("folder rollup counts descendants across all ancestors", () => {
  const changes = collectSessionChanges([
    user(), tool("Edit", ["src/ui/a.ts"]), tool("delete_file", ["src/b.ts"]),
  ], []);
  const folders = rollupFolders(changes);
  assert.equal(folders.get("src")?.count, 2);
  assert.equal(folders.get("src/ui")?.count, 1);
  assert.equal(folders.get("src")?.deletedOnly, false);
  assert.equal(folders.get("src")?.latestTurn, true);
  assert.equal(folders.has(""), false);
  const onlyDeleted = rollupFolders(collectSessionChanges([tool("delete_file", ["x/y.ts"])], []));
  assert.equal(onlyDeleted.get("x")?.deletedOnly, true);
});

test("changed-only filter keeps changed files and their ancestors", () => {
  const changes = collectSessionChanges([tool("Edit", ["src/ui/a.ts"])], []);
  const folders = rollupFolders(changes);
  assert.equal(isVisibleWhenChangedOnly("src", true, changes, folders), true);
  assert.equal(isVisibleWhenChangedOnly("src/ui/a.ts", false, changes, folders), true);
  assert.equal(isVisibleWhenChangedOnly("src/ui/b.ts", false, changes, folders), false);
  assert.equal(isVisibleWhenChangedOnly("docs", true, changes, folders), false);
});

test("deletedChildren lists only missing deleted files directly under the directory", () => {
  const changes = collectSessionChanges([
    tool("delete_file", ["src/gone.ts", "src/deep/gone.ts", "src/here.ts"]),
  ], []);
  assert.deepEqual(deletedChildren("src", [{ path: "src/here.ts" }], changes), ["src/gone.ts"]);
  assert.deepEqual(deletedChildren("src/deep", [], changes), ["src/deep/gone.ts"]);
});

test("deletedFolders lists removed folders that still hold deleted files", () => {
  const changes = collectSessionChanges([
    tool("delete_file", ["src/gone/a.ts", "src/gone/deep/b.ts", "src/kept/c.ts", "top/x.ts"]),
    tool("Edit", ["src/edited/d.ts"]),
  ], []);
  assert.deepEqual(deletedFolders("src", [{ path: "src/kept" }], changes), ["src/gone"]);
  assert.deepEqual(deletedFolders("src/gone", [], changes), ["src/gone/deep"]);
  assert.deepEqual(deletedFolders("", [{ path: "src" }], changes), ["top"]);
});

test("changesKey changes with the set or a kind, not with order", () => {
  const a = collectSessionChanges([tool("Edit", ["a.ts"]), tool("Edit", ["b.ts"])], []);
  const b = collectSessionChanges([tool("Edit", ["b.ts"]), tool("Edit", ["a.ts"])], []);
  const c = collectSessionChanges([tool("Edit", ["a.ts"]), tool("delete_file", ["b.ts"])], []);
  assert.equal(changesKey(a), changesKey(b));
  assert.notEqual(changesKey(a), changesKey(c));
});
