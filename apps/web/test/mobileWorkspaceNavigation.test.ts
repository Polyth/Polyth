import test from "node:test";
import assert from "node:assert/strict";
import {
  getMobileWorkspaceNavigationSnapshot,
  hideMobileWorkspaceHome,
  rememberMobileWorkspacePackage,
  showMobileWorkspaceHome,
} from "../src/mobileWorkspaceNavigation.ts";

test("mobile Workspace distinguishes Back navigation from dismissal", () => {
  showMobileWorkspaceHome();
  assert.deepEqual(getMobileWorkspaceNavigationSnapshot(), {
    homeOpen: true,
    lastPackageId: null,
  });

  rememberMobileWorkspacePackage("git");
  assert.deepEqual(getMobileWorkspaceNavigationSnapshot(), {
    homeOpen: false,
    lastPackageId: "git",
  });

  // Dismissal/new-chat style exits preserve the package resume target.
  hideMobileWorkspaceHome();
  assert.equal(getMobileWorkspaceNavigationSnapshot().lastPackageId, "git");

  // Back is real navigation: Workspace becomes the current destination.
  showMobileWorkspaceHome();
  assert.deepEqual(getMobileWorkspaceNavigationSnapshot(), {
    homeOpen: true,
    lastPackageId: null,
  });
});
