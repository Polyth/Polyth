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
  // It hides itself in the single-Space installation that most users have.
  assert.match(switcher, /state\.spaces\.length < 2/);
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
