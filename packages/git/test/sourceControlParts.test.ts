import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  },
});
register("./tsxHooks.mjs", import.meta.url);

const { getGitPrefs, parseGitPrefOverrides, setGitPrefs, replaceGitPrefs, GIT_PREFS_DEFAULTS } = await import("../widgets/gitPrefs.ts");
const { buildChangeTree } = await import("../widgets/ChangeList.tsx");
const { parseDiffLines, pairSplitRows, parseCommitPrelude } = await import("../widgets/DiffViewer.tsx");
const { diffBarCells, formatWhen, refKind } = await import("../widgets/sourceControlParts.tsx");

test("repository scopes inherit account display defaults and keep only their own overrides", () => {
  const scope = "prefs-project\0\0primary";
  replaceGitPrefs({ ...GIT_PREFS_DEFAULTS });
  setGitPrefs({ layout: "split" }, scope);
  assert.equal(getGitPrefs(scope).layout, "split", "the scope keeps its diff layout");

  setGitPrefs({ changesView: "flat", lineStats: "bar", density: "comfortable", wrap: true });
  const scoped = getGitPrefs(scope);
  assert.equal(scoped.changesView, "flat", "an account default reaches a scope that never chose");
  assert.equal(scoped.lineStats, "bar");
  assert.equal(scoped.density, "comfortable");
  assert.equal(scoped.wrap, true);
  assert.equal(scoped.layout, "split", "the scope's own choice still wins");

  setGitPrefs({ layout: "unified" });
  assert.equal(getGitPrefs(scope).layout, "split", "changing the default does not overwrite a scope override");
  replaceGitPrefs({ ...GIT_PREFS_DEFAULTS });
});

test("stored scope overrides parse only validated keys", () => {
  assert.deepEqual(parseGitPrefOverrides('{"layout":"split","density":"huge","logGraph":false,"lineStats":7}'), { layout: "split", logGraph: false });
  assert.deepEqual(parseGitPrefOverrides("[]"), {});
  assert.deepEqual(parseGitPrefOverrides("not json"), {});
});

test("change tree folds single-child folder chains and sorts folders before files", () => {
  const file = (path: string) => ({ path, status: "modified", staged: false });
  const tree = buildChangeTree([
    file("packages/git/widgets/GitView.tsx"),
    file("packages/git/widgets/styles.css"),
    file("packages/git/src/index.ts"),
    file("README.md"),
  ]);
  assert.equal(tree.total, 4);
  assert.deepEqual(tree.files.map((entry) => entry.path), ["README.md"]);
  const [packages] = [...tree.dirs.values()];
  assert.equal(packages!.name, "packages/git", "packages → git folds into one row");
  assert.deepEqual([...packages!.dirs.values()].map((dir) => [dir.name, dir.total]), [["src", 1], ["widgets", 2]]);
  const widgets = [...packages!.dirs.values()][1]!;
  assert.deepEqual(widgets.files.map((entry) => entry.path), ["packages/git/widgets/GitView.tsx", "packages/git/widgets/styles.css"]);
});

test("diff lines carry old/new numbers from hunk headers and drop file headers", () => {
  const lines = parseDiffLines([
    "diff --git a/a.ts b/a.ts",
    "index 1..2 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,3 +10,4 @@ fn()",
    " keep",
    "-old",
    "+new",
    "+added",
    "\\ No newline at end of file",
  ].join("\n"));
  assert.deepEqual(lines.map((line) => [line.kind, line.oldLine ?? null, line.newLine ?? null, line.text]), [
    ["hunk", null, null, "@@ -10,3 +10,4 @@ fn()"],
    ["ctx", 10, 10, "keep"],
    ["del", 11, null, "old"],
    ["add", null, 11, "new"],
    ["add", null, 12, "added"],
    ["meta", null, null, "\\ No newline at end of file"],
  ]);
  const rows = pairSplitRows(lines);
  assert.equal(rows[2]!.left?.text, "old");
  assert.equal(rows[2]!.right?.text, "new");
  assert.equal(rows[3]!.left, undefined, "an unmatched addition leaves the old side empty");
  assert.equal(rows[3]!.right?.text, "added");
});

test("commit prelude yields the message body without the subject", () => {
  const diff = "commit abc\nAuthor: A <a@x>\nDate: today\n\n    Subject line\n\n    Body one\n    Body two\n\ndiff --git a/x b/x\n";
  assert.equal(parseCommitPrelude(diff).body, "Body one\nBody two");
  assert.equal(parseCommitPrelude("commit abc\n\n    Only subject\n").body, "");
});

test("diff bars scale with size and keep both colours when both kinds changed", () => {
  assert.deepEqual(diffBarCells({ additions: 0, deletions: 0 }), ["none", "none", "none", "none", "none"]);
  assert.deepEqual(diffBarCells({ additions: 1, deletions: 0 }), ["add", "none", "none", "none", "none"]);
  const big = diffBarCells({ additions: 900, deletions: 100 });
  assert.equal(big.filter((cell) => cell !== "none").length, 5);
  assert.ok(big.includes("del"), "a minority of deletions still shows");
  assert.deepEqual(diffBarCells({ additions: 0, deletions: 40 }).filter((cell) => cell === "add"), []);
});

test("relative dates collapse the last minute and absolute dates use the locale", () => {
  const now = Date.UTC(2026, 9, 2, 12);
  assert.equal(formatWhen(now - 10_000, "relative", now).label, "just now");
  assert.match(formatWhen(now - 3 * 3_600_000, "relative", now).label, /3/);
  assert.match(formatWhen(now - 3 * 86_400_000, "absolute", now).label, /2026/);
  assert.deepEqual(formatWhen("not a date", "relative", now), { label: "", title: "" });
});

test("log refs tell remote branches from slash-named local branches", () => {
  const remotes = new Set(["origin"]);
  assert.deepEqual(refKind("origin/main", remotes), { label: "origin/main", kind: "remote" });
  assert.deepEqual(refKind("feature/x", remotes), { label: "feature/x", kind: "local" });
  assert.deepEqual(refKind("HEAD -> feature/x", remotes), { label: "feature/x", kind: "head" });
  assert.deepEqual(refKind("tag: v1.0", remotes), { label: "v1.0", kind: "tag" });
});
