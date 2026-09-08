import test from "node:test";
import assert from "node:assert/strict";
import type { ProfileFrame } from "@polyth/browser";
import { createChatWorkspaceFrameBus, frameBusKey } from "../src/frameBus.ts";

test("popup frames keep independent revisions when main revision is high", () => {
  const tabId = "tab-popup-rev";
  let emitFrame: (frame: ProfileFrame) => void = () => {};
  const bus = createChatWorkspaceFrameBus({
    resolveSpaceId: () => "space-a",
    onFrame: (cb) => {
      emitFrame = cb;
      return { dispose: () => {} };
    },
    onEvent: () => ({ dispose: () => {} }),
    setTabStream: () => {},
  });

  for (let revision = 1; revision <= 100; revision++) {
    emitFrame({
      tabId,
      revision,
      mime: "image/jpeg",
      data: new Uint8Array([revision]),
      width: 1280,
      height: 800,
    });
  }

  emitFrame({
    tabId,
    revision: 1,
    mime: "image/jpeg",
    data: new Uint8Array([201]),
    width: 960,
    height: 720,
    popupId: "popup-oauth",
  });

  const main = bus.latestFrame("space-a", tabId, 99);
  const popup = bus.latestFrame("space-a", tabId, 0, "popup-oauth");
  assert.equal(main?.revision, 100);
  assert.equal(popup?.revision, 1);
  assert.equal(popup?.popupId, "popup-oauth");
  assert.equal(frameBusKey("space-a", tabId, "popup-oauth"), "space-a:tab-popup-rev:popup:popup-oauth");
});
