import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SpacesStateDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import {
  activeSpace,
  getSpacesState,
  loadSpaces,
  switchSpace,
  __setSpacesStateForTest,
} from "../src/spaces.ts";

const source = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

const dto = (activeSpaceId: string): SpacesStateDto => ({
  user: { id: "usr_owner", name: "Owner", createdAt: 1 },
  spaces: [
    { id: "spc_home", name: "Home", slug: "home", createdAt: 1, updatedAt: 1, isDefault: true, role: "owner", memberCount: 1 },
    { id: "spc_work", name: "Work", slug: "work", createdAt: 2, updatedAt: 2, isDefault: false, role: "owner", memberCount: 1 },
  ],
  activeSpaceId,
  deployment: "local-trusted",
  canCreate: true,
});

test("the client mirrors the server's active Space and never picks one itself", async () => {
  const original = api.spaces;
  api.spaces = async () => dto("spc_work");
  try {
    await loadSpaces();
    const state = getSpacesState();
    assert.equal(state.status, "ready");
    assert.equal(state.activeSpaceId, "spc_work");
    assert.equal(activeSpace(state)?.name, "Work");
    // The list is whatever the server returned — the client does no filtering
    // of its own, because it has no authority to.
    assert.deepEqual(state.spaces.map((s) => s.id), ["spc_home", "spc_work"]);
  } finally {
    api.spaces = original;
  }
});

test("switching is a server call, and a failure leaves the previous Space active", async () => {
  const original = api.activateSpace;
  __setSpacesStateForTest({
    status: "ready",
    spaces: dto("spc_home").spaces,
    activeSpaceId: "spc_home",
    switching: false,
    canCreate: true,
  });

  const asked: string[] = [];
  api.activateSpace = async (id: string) => {
    asked.push(id);
    throw Object.assign(new Error("not allowed"), { code: "not-found" });
  };
  try {
    await switchSpace("spc_work");
    assert.deepEqual(asked, ["spc_work"]);
    assert.equal(getSpacesState().activeSpaceId, "spc_home", "a rejected switch does not move the client");
    assert.equal(getSpacesState().switching, false);

    // Switching to the Space already active is a no-op, not a redundant call.
    await switchSpace("spc_home");
    assert.deepEqual(asked, ["spc_work"]);
  } finally {
    api.activateSpace = original;
  }
});

test("a Space switch reloads the shell instead of patching state in place", () => {
  const spaces = source("../src/spaces.ts");
  // Anything a previous Space put in memory (sessions, drafts, model catalog,
  // package state, the WS subscription) must not survive the switch.
  assert.match(spaces, /window\.location\.assign\("\/"\)/);
  assert.ok(
    !/localStorage/.test(spaces),
    "the active Space is server-side state, never a client-side preference",
  );
});

test("the switcher is quiet, server-driven, and reachable on phones", () => {
  const switcher = source("../src/components/SpaceSwitcher.tsx");
  const header = source("../src/components/Header.tsx");
  const sidebar = source("../src/components/Sidebar.tsx");

  assert.ok(header.includes("<SpaceSwitcher />"), "the header carries the switcher on desktop");
  assert.ok(sidebar.includes("<SpaceSwitcher />"), "the phone drawer carries it too");
  // It hides itself in the single-Space installation that most users have
  // (one Space here and none joined on another server).
  assert.match(switcher, /state\.spaces\.length \+ state\.joined\.length < 2/);
  // Menu entries come straight from the server payload — no client filtering.
  assert.match(switcher, /state\.spaces\.map/);
  assert.ok(!switcher.includes("header-brand"), "it does not restyle the brand");
});

test("space switcher styles use canonical tokens only", () => {
  const styles = source("../src/styles.css");
  const block = styles.slice(styles.indexOf(".space-switcher {"), styles.indexOf(".workspace-customize {"));
  assert.ok(block.length > 0, "the switcher has styles");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), "no hardcoded colors");
  assert.match(block, /var\(--radius-control\)/);
  assert.match(block, /var\(--muted\)/);
});

test("a joined Space of another server is listed apart, can be active, and is never one of this server's", async () => {
  const original = api.spaces;
  const { activeJoinedSpace } = await import("../src/spaces.ts");
  const joined = { id: "rmt_0123456789abcdef01234567", name: "Team", role: "member" as const, memberCount: 3, serverLabel: "Studio", connectionId: "conn-1", online: true };
  api.spaces = async () => ({ ...dto(joined.id), joined: [joined] });
  try {
    await loadSpaces();
    const state = getSpacesState();
    assert.deepEqual(state.joined.map((space) => space.id), [joined.id]);
    assert.equal(activeSpace(state), undefined, "this server has no Space with that id");
    assert.equal(activeJoinedSpace(state)?.serverLabel, "Studio");
    // An older server sends no `joined` at all.
    api.spaces = async () => dto("spc_home");
    await loadSpaces();
    assert.deepEqual(getSpacesState().joined, []);
  } finally {
    api.spaces = original;
  }
  const switcher = source("../src/components/SpaceSwitcher.tsx");
  assert.match(switcher, /state\.spaces\.length \+ state\.joined\.length < 2/, "one own Space plus a joined one is a choice");
  assert.match(switcher, /openSettingsPage\("tunnel", \{ sectionId: "join" \}\)/, "joining lives on the Polyth Link page");
});

test("in another server's Space, settings list only the person's own pages, the projects and Polyth Link", async () => {
  const { joinedSpaceSettingsPageVisible } = await import("../src/joinedSpaceSettings.ts");
  for (const page of ["appearance", "chat", "notifications", "projects", "tunnel"]) {
    assert.equal(joinedSpaceSettingsPageVisible(true, page), true, page);
  }
  for (const page of ["harnesses", "behavior", "mcp", "packages", "users", "secure-safe", "ssh", "about"]) {
    assert.equal(joinedSpaceSettingsPageVisible(true, page), false, `${page} changes this computer, not the open Space`);
    assert.equal(joinedSpaceSettingsPageVisible(false, page), true, `${page} shows in this server's own Spaces`);
  }
  const view = source("../src/components/SettingsView.tsx");
  assert.match(view, /joinedSpaceSettingsPageVisible\(inJoinedSpace, page\.id\)/);
  assert.match(view, /settings-joined-note/);
});

test("in another server's Space, \"me\" is the person's account there", async () => {
  const { selfInOpenSpace } = await import("../src/spaces.ts");
  const original = api.spaces;
  const joined = { id: "rmt_0123456789abcdef01234567", name: "Team", role: "member" as const, memberCount: 3, serverLabel: "Studio", connectionId: "conn-1", online: true, remoteUserId: "usr_bob_there" };
  try {
    api.spaces = async () => ({ ...dto(joined.id), joined: [joined] });
    await loadSpaces();
    assert.equal(selfInOpenSpace("usr_owner"), "usr_bob_there");
    api.spaces = async () => ({ ...dto("spc_home"), joined: [joined] });
    await loadSpaces();
    assert.equal(selfInOpenSpace("usr_owner"), "usr_owner", "this server's own Spaces keep this server's account");
  } finally {
    api.spaces = original;
  }
});

test("a Space switch forgets the remembered project and chat of the Space being left", () => {
  const spaces = source("../src/spaces.ts");
  const store = source("../src/store.ts");
  assert.match(spaces, /forgetNavigationHints\(\)/);
  assert.match(store, /export function forgetNavigationHints\(\): void \{\n  saveNavigationHint\("polyth\.activeProjectId", ""\);\n  saveNavigationHint\("polyth\.activeSessionId", ""\);/);
});
