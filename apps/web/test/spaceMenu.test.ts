// The Space menu (components/spaceMenu.tsx) shared by the header switcher and
// the phone Navigator: Spaces grouped by the server they live on, so every
// server's first "Personal" Space tells itself apart, then the actions.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { JoinedSpaceDto, SpaceSummaryDto } from "@polyth/contracts";
import { __setSpacesStateForTest, getSpacesState, type SpacesState } from "../src/spaces.ts";
import { registerSlot } from "../src/slots.ts";
import type { MenuEntry } from "../src/components/ui/index.ts";

register("./tsxHooks.mjs", import.meta.url);
const {
  SPACES_SECTIONS_SLOT,
  spaceMenuEntries,
  spaceServerGroups,
  spaceTones,
} = await import("../src/components/spaceMenu.tsx");

const own = (id: string, name: string, extra: Partial<SpaceSummaryDto> = {}): SpaceSummaryDto => ({
  id, name, slug: id, createdAt: 1, updatedAt: 1, isDefault: false, role: "owner", memberCount: 1, ...extra,
});
const there = (id: string, name: string, server: string, online = true): JoinedSpaceDto => ({
  id, name, role: "member", memberCount: 2, serverLabel: server, connectionId: `conn-${server}`, online,
});

const state = (patch: Partial<SpacesState>): SpacesState => {
  __setSpacesStateForTest({
    status: "ready", spaces: [], joined: [], serverName: null, activeSpaceId: null, switching: false, canCreate: true,
    ...patch,
  });
  return getSpacesState();
};

/** The menu as text: headings as `# name (detail)`, rows by label, actions by id. */
const outline = (entries: MenuEntry[]): string[] => entries.map((entry) => {
  if (entry === "separator") return "---";
  if ("heading" in entry) return `# ${entry.heading}${entry.detail ? ` (${entry.detail})` : ""}`;
  return entry.id.startsWith("space:") ? `${entry.checked ? "✓ " : ""}${entry.label}` : entry.id;
});

test("one server: its Spaces with no heading, then the actions", () => {
  const entries = spaceMenuEntries(state({
    spaces: [own("spc_home", "Personal", { isDefault: true }), own("spc_work", "Work")],
    activeSpaceId: "spc_home",
  }));
  assert.deepEqual(outline(entries), ["✓ Personal", "Work", "---", "spaces:new", "spaces:manage"]);
});

test("beside another server, each server heads its own Spaces, so two \"Personal\"s never look alike", () => {
  const entries = spaceMenuEntries(state({
    spaces: [own("spc_home", "Personal", { isDefault: true })],
    joined: [there("rmt_a", "Personal", "worker"), there("rmt_b", "Team", "studio", false)],
    serverName: "main",
    activeSpaceId: "rmt_a",
  }));
  assert.deepEqual(outline(entries), [
    "# main (This server)", "Personal",
    "# worker", "✓ Personal",
    "# studio (Offline)", "Team",
    "---", "spaces:new", "spaces:manage",
  ]);
  // Without a chosen name this server is "This server", said once.
  const unnamed = outline(spaceMenuEntries(state({ ...getSpacesState(), serverName: null })));
  assert.equal(unnamed[0], "# This server");
});

test("groups keep the server's order and gather one server's Spaces together", () => {
  const groups = spaceServerGroups({
    spaces: [own("spc_home", "Personal")],
    joined: [there("rmt_a", "A", "worker"), there("rmt_b", "B", "studio"), there("rmt_c", "C", "worker")],
    serverName: null,
  });
  assert.deepEqual(groups.map((group) => [group.label, group.spaces.map((space) => space.name)]), [
    ["This server", ["Personal"]], ["worker", ["A", "C"]], ["studio", ["B"]],
  ]);
});

test("every Space the person can open has a tone of its own", () => {
  const tones = spaceTones({
    spaces: [own("spc_home", "Personal"), own("spc_work", "Work")],
    joined: [there("rmt_a", "Personal", "worker")],
  });
  assert.equal(new Set(tones.values()).size, 3);
});

test("creating needs the right to; joining needs a package that offers it; extras close the list", () => {
  const base = { spaces: [own("spc_home", "Personal"), own("spc_work", "Work")], activeSpaceId: "spc_home" };
  assert.deepEqual(outline(spaceMenuEntries(state({ ...base, canCreate: false }))).slice(-2), ["---", "spaces:manage"]);

  const off = registerSlot(SPACES_SECTIONS_SLOT, "test.joined-servers", () => null, 0, { joinsServers: true }, "test");
  try {
    const extra: MenuEntry = { id: "server", label: "Switch server", onSelect: () => {} };
    assert.deepEqual(outline(spaceMenuEntries(state(base), [extra])).slice(-4), [
      "spaces:new", "spaces:manage", "spaces:join", "server",
    ]);
  } finally {
    off();
  }
  assert.equal(outline(spaceMenuEntries(state(base))).includes("spaces:join"), false);
});
