import test from "node:test";
import assert from "node:assert/strict";
import type { ProfileFrame } from "@polyth/browser";
import { createChatWorkspaceFrameBus, frameBusKey } from "../src/frameBus.ts";

test("frame bus isolates frames by space even when tab ids match", () => {
  const tabId = "tab-shared";
  let emitFrame: (frame: ProfileFrame) => void = () => {};
  const bus = createChatWorkspaceFrameBus({
    resolveSpaceId: (id) => (id === tabId ? "space-a" : undefined),
    onFrame: (cb) => {
      emitFrame = cb;
      return { dispose: () => {} };
    },
    onEvent: () => ({ dispose: () => {} }),
    setTabStream: () => {},
  });

  const receivedA: string[] = [];
  const receivedB: string[] = [];
  bus.onFrame((frame) => {
    if (frame.spaceId === "space-a") receivedA.push(frame.tabId);
    if (frame.spaceId === "space-b") receivedB.push(frame.tabId);
  });

  emitFrame({
    tabId,
    revision: 1,
    mime: "image/jpeg",
    data: new Uint8Array([1]),
    width: 10,
    height: 10,
  });

  assert.equal(bus.latestFrame("space-a", tabId)?.spaceId, "space-a");
  assert.equal(bus.latestFrame("space-b", tabId), null);
  assert.deepEqual(receivedA, [tabId]);
  assert.deepEqual(receivedB, []);
  assert.equal(frameBusKey("space-a", tabId), "space-a:tab-shared");
});

test("subscriber bound to space A never receives space B frames", () => {
  const tabId = "tab-1";
  let emitFrame: (frame: ProfileFrame) => void = () => {};
  const tabSpaces = new Map<string, string>([[tabId, "space-a"]]);
  const bus = createChatWorkspaceFrameBus({
    resolveSpaceId: (id) => tabSpaces.get(id),
    onFrame: (cb) => {
      emitFrame = cb;
      return { dispose: () => {} };
    },
    onEvent: () => ({ dispose: () => {} }),
    setTabStream: () => {},
  });

  const subA: string[] = [];
  const subB: string[] = [];
  const deliver = (spaceId: string | null, frame: { spaceId: string; tabId: string }) => {
    if (spaceId !== null && frame.spaceId !== spaceId) return;
    if (frame.tabId !== tabId) return;
    if (spaceId === "space-a") subA.push(frame.tabId);
    if (spaceId === "space-b") subB.push(frame.tabId);
  };

  bus.onFrame((frame) => {
    deliver("space-a", frame);
    deliver("space-b", frame);
  });

  emitFrame({ tabId, revision: 1, mime: "image/jpeg", data: new Uint8Array([1]), width: 1, height: 1 });
  tabSpaces.set(tabId, "space-b");
  emitFrame({ tabId, revision: 2, mime: "image/jpeg", data: new Uint8Array([2]), width: 1, height: 1 });

  assert.deepEqual(subA, ["tab-1"]);
  assert.deepEqual(subB, ["tab-1"]);
  assert.equal(bus.latestFrame("space-a", tabId)?.revision, 1);
  assert.equal(bus.latestFrame("space-b", tabId)?.revision, 2);
});

test("a subscriber cannot start or pause a stream for a tab owned by another space", () => {
  const tabId = "tab-owned-by-a";
  const calls: Array<{ tabId: string; visible: boolean }> = [];
  const bus = createChatWorkspaceFrameBus({
    resolveSpaceId: (id) => (id === tabId ? "space-a" : undefined),
    onFrame: () => ({ dispose: () => {} }),
    onEvent: () => ({ dispose: () => {} }),
    setTabStream: (id, visible) => { calls.push({ tabId: id, visible }); },
  });

  bus.setTabStream("space-b", tabId, true);
  bus.setTabStream("space-b", tabId, false);
  assert.deepEqual(calls, [], "another space's socket must not drive the stream");

  bus.setTabStream("space-a", "unknown-tab", true);
  assert.deepEqual(calls, [], "unknown tabs are ignored");

  bus.setTabStream("space-a", tabId, true);
  bus.setTabStream(null, tabId, false);
  assert.deepEqual(calls, [
    { tabId, visible: true },
    { tabId, visible: false },
  ]);
});
