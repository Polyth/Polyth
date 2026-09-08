import test from "node:test";
import assert from "node:assert/strict";
import { classifyTopLevelRequest, isTopLevelNavigationRequest } from "../src/index.ts";

function req(opts: {
  navigation?: boolean;
  frame?: { parentFrame(): unknown | null } | null;
  throwFrame?: boolean;
}): { isNavigationRequest(): boolean; frame(): { parentFrame(): unknown | null } | null } {
  return {
    isNavigationRequest: () => opts.navigation !== false,
    frame: () => {
      if (opts.throwFrame) throw new Error("detached");
      return opts.frame === undefined ? null : opts.frame;
    },
  };
}

test("subresources are not top-level navigations", () => {
  assert.equal(isTopLevelNavigationRequest(req({ navigation: false, frame: null })), false);
});

test("navigation with no frame yet is a top-level candidate", () => {
  assert.equal(isTopLevelNavigationRequest(req({ frame: null })), true);
});

test("detached frame lookup is treated conservatively as top-level", () => {
  assert.equal(isTopLevelNavigationRequest(req({ throwFrame: true })), true);
});

test("main-frame navigation is top-level", () => {
  assert.equal(isTopLevelNavigationRequest(req({
    frame: { parentFrame: () => null },
  })), true);
});

test("nested iframe navigation is not top-level", () => {
  assert.equal(isTopLevelNavigationRequest(req({
    frame: { parentFrame: () => ({}) },
  })), false);
});

const tabA = { id: "tab-a" };
const tabB = { id: "tab-b" };
const popup = { id: "popup" };
const lookup = {
  isResident: (page: unknown) => page === tabA || page === tabB,
  isOwnedTab: (page: unknown) => page === tabA || page === tabB,
  isKnownPopup: (page: unknown) => page === popup,
};

function classifyReq(opts: {
  navigation?: boolean;
  throwFrame?: boolean;
  frameNull?: boolean;
  parent?: unknown;
  page?: unknown;
  pageThrows?: boolean;
}) {
  return {
    isNavigationRequest: () => opts.navigation !== false,
    frame: () => {
      if (opts.throwFrame) throw new Error("detached");
      if (opts.frameNull) return null;
      return {
        parentFrame: () => (opts.parent === undefined ? null : opts.parent),
        page: () => {
          if (opts.pageThrows) throw new Error("unattached page");
          return opts.page;
        },
      };
    },
  };
}

test("subresource requests classify as resident", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ navigation: false, page: tabB }), lookup), "resident");
});

test("nested iframe navigation classifies as resident", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ parent: {}, page: tabB }), lookup), "resident");
});

test("resident tab B stays resident while an unrelated popup is known", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ page: tabB }), lookup), "resident");
});

test("resident tab A stays resident while an unrelated popup is known", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ page: tabA }), lookup), "resident");
});

test("a wired popup page classifies as known-popup", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ page: popup }), lookup), "known-popup");
});

test("unattached frame classifies as initial-popup", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ throwFrame: true }), lookup), "initial-popup");
});

test("missing frame classifies as initial-popup", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ frameNull: true }), lookup), "initial-popup");
});

test("missing page on a top-level frame classifies as initial-popup", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ page: null }), lookup), "initial-popup");
});

test("page() throw classifies as initial-popup", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ pageThrows: true }), lookup), "initial-popup");
});

test("unknown unmatched page classifies as initial-popup", () => {
  assert.equal(classifyTopLevelRequest(classifyReq({ page: { id: "other" } }), lookup), "initial-popup");
});
