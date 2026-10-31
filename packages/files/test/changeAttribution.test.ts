import test from "node:test";
import assert from "node:assert/strict";
import { unifiedDiff } from "../../../apps/web/src/diff.ts";
import { fragmentFromReplace, fragmentsFromDiff, toolEditFragments } from "../widgets/editor/editFragments.ts";
import {
  assignTones,
  buildCheckoutEdits,
  sessionToneColor,
  treeChanges,
  type EditCall,
  type EditSource,
} from "../widgets/editor/checkoutEdits.ts";
import { attributeChanges } from "../widgets/editor/changeAttribution.ts";

const call = (callId: string, seq: number, tool: string, input: Record<string, unknown>, changedFiles: string[], time = seq): EditCall =>
  ({ callId, seq, time, tool, input: input as EditCall["input"], changedFiles });

const source = (sessionId: string, calls: EditCall[], extra: Partial<EditSource> = {}): EditSource =>
  ({ sessionId, title: `Chat ${sessionId}`, createdAt: 0, viewer: false, calls, ...extra });

test("a replacement writes only the lines that differ from the old text", () => {
  const fragment = fragmentFromReplace("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.equal(fragment?.text, "a\nB\nc\nd\ne");
  assert.deepEqual(fragment?.written, [1, 4]);
  assert.deepEqual(fragment?.removed, ["b"]);
  assert.deepEqual(fragmentFromReplace("", "new"), { text: "new", written: null, removed: [] });
  assert.deepEqual(fragmentFromReplace("gone\nlines", ""), { text: "", written: [], removed: ["gone", "lines"] });
  assert.equal(fragmentFromReplace("same", "same"), null);
  // Context far from the change is outside the snippet diff hunk but offsets stay exact.
  const far = fragmentFromReplace("1\n2\n3\n4\n5\n6\n7\n8\n9", "1\n2\n3\n4\n5\n6\n7\n8\nNINE");
  assert.deepEqual(far?.written, [8]);
});

test("diff fragments keep each hunk's new side and mark its added lines", () => {
  const diff = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n x\n+y\n z";
  assert.deepEqual(fragmentsFromDiff(diff), [
    { text: "a\nB\nc", written: [1], removed: ["b"] },
    { text: "x\ny\nz", written: [1], removed: [] },
  ]);
});

test("tool payloads from every harness shape yield per-file fragments", () => {
  assert.deepEqual(toolEditFragments({ file_path: "/r/a.ts", old_string: "x", new_string: "y" }).map((file) => file.path), ["/r/a.ts"]);
  const multi = toolEditFragments({ file_path: "/r/m.ts", edits: [{ old_string: "a", new_string: "A" }, { old_string: "b", new_string: "B" }] });
  assert.equal(multi[0]?.fragments.length, 2);
  assert.deepEqual(toolEditFragments({ file_path: "/r/w.ts", content: "body\n" })[0]?.fragments, [{ text: "body\n", written: null, removed: [] }]);
  const codex = toolEditFragments({ changes: [
    { path: "/r/c.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new" },
    { path: "/r/n.ts", kind: { type: "add" }, diff: "fresh\nfile" },
  ] });
  assert.deepEqual(codex.map((file) => [file.path, file.fragments[0]?.text]), [["/r/c.ts", "new"], ["/r/n.ts", "fresh\nfile"]]);
  const patch = toolEditFragments({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+one\n*** Add File: src/b.ts\n+hello\n*** End Patch" });
  assert.deepEqual(patch.map((file) => [file.path, file.fragments.map((fragment) => fragment.text)]), [["src/a.ts", ["one"]], ["src/b.ts", ["hello"]]]);
  assert.deepEqual(toolEditFragments({ command: "ls" }), []);
});

test("tones: the viewing chat is slot 0, others by creation order", () => {
  const tones = assignTones([
    { sessionId: "late", createdAt: 30, viewer: false },
    { sessionId: "me", createdAt: 20, viewer: true },
    { sessionId: "early", createdAt: 10, viewer: false },
  ]);
  assert.deepEqual([...tones], [["me", 0], ["early", 1], ["late", 2]]);
  assert.equal(sessionToneColor(2), "var(--session-tone-2)");
  assert.equal(sessionToneColor(-1), "var(--session-tone-none)");
});

test("checkout edits merge chats per file and keep every edit for attribution", () => {
  const edits = buildCheckoutEdits([
    source("me", [
      call("m1", 5, "Write", { file_path: "/repo/a.ts", content: "a\n" }, ["/repo/a.ts"]),
      call("m2", 9, "Edit", { file_path: "/repo/b.ts", old_string: "x", new_string: "y" }, ["/repo/b.ts"]),
    ], { viewer: true, createdAt: 50, lastUserSeq: 8 }),
    source("other", [
      call("o1", 3, "Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "A" }, ["/repo/a.ts"], 100),
      call("o2", 4, "Edit", { file_path: "/elsewhere/c.ts", old_string: "1", new_string: "2" }, ["/elsewhere/c.ts"]),
    ], { createdAt: 10 }),
    source("idle", [], { createdAt: 5 }),
  ], ["/repo"], [{ path: "a.ts", status: "untracked" }]);
  assert.deepEqual(edits.sessions.map((session) => [session.sessionId, session.tone]), [["me", 0], ["other", 1]]);
  const a = edits.files.get("a.ts")!;
  assert.deepEqual(a.sessions, ["me", "other"]);
  assert.equal(a.kind, "created");
  assert.deepEqual(a.edits.map((edit) => edit.sessionId), ["me", "other"]);
  assert.equal(a.latestTurn, false);
  assert.equal(edits.files.get("b.ts")?.latestTurn, true);
  assert.equal(edits.files.has("c.ts"), false);
});

test("the tree keeps the viewing chat's files and other chats' files only while uncommitted", () => {
  const edits = buildCheckoutEdits([
    source("me", [call("m", 1, "Edit", { file_path: "mine.ts", old_string: "a", new_string: "b" }, ["mine.ts"])], { viewer: true }),
    source("other", [
      call("o1", 1, "Edit", { file_path: "dirty.ts", old_string: "a", new_string: "b" }, ["dirty.ts"]),
      call("o2", 2, "Edit", { file_path: "done.ts", old_string: "a", new_string: "b" }, ["done.ts"]),
    ]),
  ], []);
  assert.deepEqual([...treeChanges(edits, "me", new Set(["dirty.ts"])).keys()].sort(), ["dirty.ts", "mine.ts"]);
});

const record = (sessionId: string, time: number, fragments: ReturnType<typeof toolEditFragments>[number]["fragments"]) =>
  ({ sessionId, seq: time, time, fragments });

test("the newest writer of a line owns it; context repeated by an edit is not claimed", () => {
  const base = "one\ntwo\n";
  const afterA = "one\nalpha\nbeta\ngamma\ndelta\ntwo\n";
  const current = "one\nalpha\nbeta\nGAMMA\ndelta\ntwo\n";
  const a = fragmentFromReplace("one\ntwo", "one\nalpha\nbeta\ngamma\ndelta\ntwo")!;
  const b = fragmentFromReplace("beta\ngamma\ndelta", "beta\nGAMMA\ndelta")!;
  assert.ok(afterA);
  const hunks = attributeChanges({
    text: current,
    diff: unifiedDiff(base, current, "f.ts"),
    edits: [record("B", 20, [b]), record("A", 10, [a])],
  });
  assert.ok(hunks);
  assert.deepEqual(hunks.flatMap((hunk) => hunk.lines.map((line) => [line.line, line.owner])), [
    [2, "A"], [3, "A"], [4, "B"], [5, "A"],
  ]);
});

test("an edit split by a later insertion keeps both of its surviving parts", () => {
  const base = "one\ntwo\n";
  const current = "one\nalpha\nbeta\nINSERTED\ngamma\ndelta\ntwo\n";
  const hunks = attributeChanges({
    text: current,
    diff: unifiedDiff(base, current, "f.ts"),
    edits: [
      record("A", 10, [fragmentFromReplace("one\ntwo", "one\nalpha\nbeta\ngamma\ndelta\ntwo")!]),
      record("B", 20, [fragmentFromReplace("beta\ngamma", "beta\nINSERTED\ngamma")!]),
    ],
  })!;
  assert.deepEqual(hunks.flatMap((hunk) => hunk.lines.map((line) => [line.line, line.owner])), [
    [2, "A"], [3, "A"], [4, "B"], [5, "A"], [6, "A"],
  ]);
});

test("removals belong to the replacement's writer, else to the edit that removed the text", () => {
  const base = "keep\nold line\nkeep2\ndrop me\nend\n";
  const current = "keep\nnew line\nkeep2\nend\n";
  const hunks = attributeChanges({
    text: current,
    diff: unifiedDiff(base, current, "f.ts"),
    edits: [
      record("A", 1, [fragmentFromReplace("old line", "new line")!]),
      record("B", 2, [fragmentFromReplace("keep2\ndrop me\nend", "keep2\nend")!]),
    ],
  })!;
  const removed = hunks.flatMap((hunk) => hunk.removed.map((block) => [block.line, block.text, block.owner]));
  assert.deepEqual(removed, [[2, ["old line"], "A"], [4, ["drop me"], "B"]]);
});

test("a single editing chat owns every change; with several chats an unexplained line stays unattributed", () => {
  const base = "a\n";
  const current = "a\nwritten by person\n";
  const diff = unifiedDiff(base, current, "f.ts");
  const sole = attributeChanges({ text: current, diff, edits: [record("A", 1, [])] })!;
  assert.deepEqual(sole[0]!.lines, [{ line: 2, owner: "A" }]);
  const shared = attributeChanges({ text: current, diff, edits: [record("A", 1, []), record("B", 2, [])] })!;
  assert.deepEqual(shared[0]!.lines, [{ line: 2, owner: null }]);
  const nobody = attributeChanges({ text: current, diff, edits: [] })!;
  assert.deepEqual(nobody[0]!.lines, [{ line: 2, owner: null }]);
});

test("a diff that no longer matches the text is stale; kept hunks are hidden", () => {
  const base = "a\nb\n";
  const current = "a\nB\n";
  const diff = unifiedDiff(base, current, "f.ts");
  assert.equal(attributeChanges({ text: "a\nsomething else\n", diff, edits: [] }), null);
  const hunks = attributeChanges({ text: current, diff, edits: [] })!;
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.anchorLine, 2);
  assert.match(hunks[0]!.digest, /^[0-9a-f]{8}$/);
  assert.deepEqual(attributeChanges({ text: current, diff, edits: [], accepted: new Set([hunks[0]!.digest]) }), []);
});

test("a fully deleted tail anchors after the last line and new files attribute whole content", () => {
  const removedTail = attributeChanges({
    text: "a\n",
    diff: unifiedDiff("a\nb\nc\n", "a\n", "f.ts"),
    edits: [record("A", 1, [fragmentFromReplace("a\nb\nc", "a")!])],
  })!;
  assert.deepEqual(removedTail[0]!.removed, [{ line: 2, text: ["b", "c"], owner: "A" }]);
  const created = attributeChanges({
    text: "x\ny\n",
    diff: unifiedDiff("", "x\ny\n", "f.ts"),
    edits: [record("A", 1, [{ text: "x\ny\n", written: null, removed: [] }]), record("B", 2, [])],
  })!;
  assert.deepEqual(created[0]!.lines.map((line) => line.owner), ["A", "A"]);
});
