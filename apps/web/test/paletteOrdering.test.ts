import test from "node:test";
import assert from "node:assert/strict";
import {
  orderEntries,
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
