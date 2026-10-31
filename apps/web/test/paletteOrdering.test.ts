import test from "node:test";
import assert from "node:assert/strict";
import {
  highlightRuns,
  orderEntries,
  rankCommands,
  type PaletteEntry,
} from "../src/paletteOrdering.ts";

const command = (id: string, group: string): PaletteEntry => ({
  kind: "cmd",
  id,
  cmd: { id, label: id, group, run: () => {} },
});

const workspace = (
  kind: "project" | "session",
  id: string,
): PaletteEntry => ({
  kind: "workspace",
  id: `${kind}:${id}`,
  item: {
    kind,
    id,
    projectId: kind === "project" ? id : "project-1",
    title: id,
    updatedAt: 1,
  },
});

const file = (path: string): PaletteEntry => ({
  kind: "file",
  id: `file:${path}`,
  hit: { path, kind: "file", score: 1, matches: [] },
});

test("desktop palette keeps commands before workspaces and files", () => {
  const entries = [
    workspace("project", "project-1"),
    file("src/main.ts"),
    command("cmd.open", "Shell"),
    workspace("session", "session-1"),
    command("cmd.new", "Session"),
  ];
  assert.deepEqual(
    orderEntries(entries, "wide").map((entry) => entry.id),
    ["cmd.open", "cmd.new", "project:project-1", "session:session-1", "file:src/main.ts"],
  );
  assert.deepEqual(
    orderEntries(entries, "compact").map((entry) => entry.id),
    ["cmd.open", "cmd.new", "project:project-1", "session:session-1", "file:src/main.ts"],
  );
});

test("phone palette keeps workspace order stable before deep search and commands", () => {
  const entries: PaletteEntry[] = [
    command("cmd.open", "Shell"),
    workspace("project", "project-1"),
    command("cmd.new", "Session"),
    workspace("session", "session-1"),
    { kind: "session-search", id: "session-search" },
    file("src/main.ts"),
  ];
  assert.deepEqual(
    orderEntries(entries, "phone").map((entry) => entry.id),
    [
      "project:project-1",
      "session:session-1",
      "session-search",
      "cmd.open",
      "cmd.new",
      "file:src/main.ts",
    ],
  );
});

test("ordering is stable within sections and accepts empty results", () => {
  const entries = [
    command("cmd.first", "One"),
    command("cmd.second", "One"),
    command("cmd.third", "Two"),
  ];
  assert.deepEqual(
    orderEntries(entries, "phone").map((entry) => entry.id),
    ["cmd.first", "cmd.second", "cmd.third"],
    "group headers remain contiguous because command order is stable",
  );
  assert.deepEqual(orderEntries([], "wide"), []);
  assert.deepEqual(orderEntries([], "phone"), []);
});

test("rankCommands keeps groups contiguous in registration order without a query", () => {
  const cmd = (id: string, group?: string) => ({ id, label: id, ...(group ? { group } : {}), run: () => {} });
  const ranked = rankCommands([cmd("a", "Shell"), cmd("b", "Panels"), cmd("c", "Shell"), cmd("d"), cmd("e", "Panels")], "");
  assert.deepEqual(ranked.map((c) => c.id), ["a", "c", "b", "e", "d"]);
});

test("rankCommands leads with the group holding the best label hit", () => {
  const ranked = rankCommands([
    { id: "x.keyword", label: "Notifications", group: "Panels", keywords: ["files"], run: () => {} },
    { id: "x.word", label: "Search files", group: "Shell", run: () => {} },
    { id: "x.prefix", label: "Files", group: "Workspace", run: () => {} },
  ], "files");
  assert.deepEqual(ranked.map((c) => c.id), ["x.prefix", "x.word", "x.keyword"]);
});

test("highlightRuns marks the folded match and refuses misaligned folds", () => {
  assert.deepEqual(highlightRuns("Café menu", "cafe"), [
    { text: "Café", match: true },
    { text: " menu", match: false },
  ]);
  assert.deepEqual(highlightRuns("Open", ""), [{ text: "Open", match: false }]);
  // A decomposed é shrinks when folded; offsets no longer line up, so the
  // run must not mark shifted characters.
  assert.deepEqual(highlightRuns("Cafe\u0301 x", "x"), [{ text: "Cafe\u0301 x", match: false }]);
});
