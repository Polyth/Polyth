import test from "node:test";
import assert from "node:assert/strict";
import {
  nextWorkspacePhase,
  packageLayerPresented,
  phoneBackTarget,
  workspaceEntryPhase,
  workspaceLayerWanted,
} from "../src/mobileLayerStack.ts";

test("a package window is presented by a rail/pane surface or a non-Chat view", () => {
  assert.equal(packageLayerPresented({ railPlugin: null, activeView: "session" }), false);
  assert.equal(packageLayerPresented({ railPlugin: "files", activeView: "session" }), true);
  assert.equal(packageLayerPresented({ railPlugin: null, activeView: "goals" }), true);
});

test("the Workspace arrives from the edge over Chat, covered under a package, revealed by Back", () => {
  assert.equal(workspaceEntryPhase({ packagePresented: false, packageWasPresented: false }), "enter");
  // Back asked for the Workspace before its idle underlay existed: the package
  // is already leaving, so the layer settles instead of sliding in from the edge.
  assert.equal(workspaceEntryPhase({ packagePresented: false, packageWasPresented: true }), "revealed");
  // The idle underlay of a package opened straight from Chat.
  assert.equal(workspaceEntryPhase({ packagePresented: true, packageWasPresented: true }), "covered");
  assert.equal(workspaceEntryPhase({ packagePresented: true, packageWasPresented: false }), "covered");
});

test("a mounted Workspace is covered while a package is on top and revealed when it leaves", () => {
  assert.equal(nextWorkspacePhase("enter", true), "covered");
  assert.equal(nextWorkspacePhase("covered", true), "covered");
  assert.equal(nextWorkspacePhase("covered", false), "revealed");
  // Nothing changes while the foreground stays foreground.
  assert.equal(nextWorkspacePhase("enter", false), "enter");
  assert.equal(nextWorkspacePhase("revealed", false), "revealed");
  // The cycle repeats: a second push covers it again.
  assert.equal(nextWorkspacePhase("revealed", true), "covered");
});

test("the Workspace is wanted in the foreground and kept beneath a package", () => {
  const base = { phone: true, homeOpen: false, packagePresented: false, mounted: false, underlaySettled: false };
  assert.equal(workspaceLayerWanted({ ...base, homeOpen: true }), true, "foreground");
  assert.equal(workspaceLayerWanted(base), false, "closed");
  assert.equal(workspaceLayerWanted({ ...base, homeOpen: true, phone: false }), false, "phone only");

  // Pushed from the Workspace: it is already mounted and stays mounted.
  assert.equal(workspaceLayerWanted({ ...base, packagePresented: true, homeOpen: true, mounted: true }), true);
  assert.equal(workspaceLayerWanted({ ...base, packagePresented: true, mounted: true }), true,
    "the resume-target bookkeeping that clears homeOpen never unmounts it");
  // Opened straight from Chat: the underlay waits until the package has landed.
  assert.equal(workspaceLayerWanted({ ...base, packagePresented: true }), false, "not mid-slide");
  assert.equal(workspaceLayerWanted({ ...base, packagePresented: true, underlaySettled: true }), true, "once settled");
  // The package left and nobody asked for the Workspace: it goes with it.
  assert.equal(workspaceLayerWanted({ ...base, mounted: true }), false, "dismissed together");
});

test("Back pops exactly one phone layer", () => {
  const base = { phone: true, homeOpen: false, packagePresented: false };
  assert.equal(phoneBackTarget({ ...base, packagePresented: true }), "package");
  assert.equal(phoneBackTarget({ ...base, packagePresented: true, homeOpen: true }), "package",
    "a package on top is popped first, whatever the Workspace flag says");
  assert.equal(phoneBackTarget({ ...base, homeOpen: true }), "workspace");
  assert.equal(phoneBackTarget(base), null, "Chat is the root");
  assert.equal(phoneBackTarget({ ...base, phone: false, packagePresented: true }), null, "the stack is a phone concept");
});
