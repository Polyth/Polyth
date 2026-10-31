import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ASSISTANT_MESSAGE_ACTIONS_DEFAULT,
  moveMessageAction,
  parseMessageActionLayout,
  resolveMessageActions,
  sameMessageActionLayout,
  setMessageActionPlacement,
  USER_MESSAGE_ACTION_IDS,
  USER_MESSAGE_ACTIONS_DEFAULT,
  withPackageMessageActions,
  type MessageActionLayout,
  type UserMessageActionId,
} from "../src/messageActionLayout.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const all = () => true;

const layout: MessageActionLayout<UserMessageActionId> = {
  items: [
    { id: "fork", placement: "bar" },
    { id: "copy", placement: "menu" },
    { id: "revert", placement: "off" },
    { id: "session", placement: "bar" },
    { id: "pin", placement: "menu" },
  ],
  reveal: "hover",
  touch: "always",
};

test("bar and menu follow the configured order and skip off actions", () => {
  assert.deepEqual(resolveMessageActions(layout, all, false), {
    mode: "hover",
    bar: ["fork", "session"],
    menu: ["copy", "pin"],
  });
  assert.equal(resolveMessageActions(layout, all, true).mode, "always");
});

test("menu-only mode folds every enabled action into the menu in order", () => {
  const menuOnly = { ...layout, touch: "menu" as const };
  assert.deepEqual(resolveMessageActions(menuOnly, all, true), {
    mode: "menu",
    bar: [],
    menu: ["fork", "copy", "session", "pin"],
  });
});

test("actions a message cannot offer drop out without reordering the rest", () => {
  const resolved = resolveMessageActions(layout, (id) => id !== "fork" && id !== "pin", false);
  assert.deepEqual(resolved.bar, ["session"]);
  assert.deepEqual(resolved.menu, ["copy"]);
});

test("moving and re-placing return new layouts and keep every action", () => {
  const moved = moveMessageAction(layout, "session", 0);
  assert.deepEqual(moved.items.map((item) => item.id), ["session", "fork", "copy", "revert", "pin"]);
  assert.deepEqual(layout.items[0], { id: "fork", placement: "bar" }, "input layout mutated");
  assert.deepEqual(moveMessageAction(layout, "fork", 99).items.at(-1), { id: "fork", placement: "bar" });
  const placed = setMessageActionPlacement(layout, "revert", "bar");
  assert.deepEqual(placed.items[2], { id: "revert", placement: "bar" });
  assert.equal(layout.items[2]!.placement, "off");
});

test("parsing keeps stored order, drops junk and appends actions this build added", () => {
  const parsed = parseMessageActionLayout(
    { items: [{ id: "session", placement: "bar" }, { id: "nope", placement: "bar" }, { id: "session", placement: "menu" }, "copy"], reveal: "menu" },
    USER_MESSAGE_ACTION_IDS,
    USER_MESSAGE_ACTIONS_DEFAULT,
  );
  assert.deepEqual(parsed.items[0], { id: "session", placement: "bar" });
  assert.deepEqual(parsed.items.map((item) => item.id).sort(), [...USER_MESSAGE_ACTION_IDS].sort());
  assert.equal(parsed.reveal, "menu");
  assert.equal(parsed.touch, USER_MESSAGE_ACTIONS_DEFAULT.touch);
  assert.ok(sameMessageActionLayout(parseMessageActionLayout(null, USER_MESSAGE_ACTION_IDS, USER_MESSAGE_ACTIONS_DEFAULT), USER_MESSAGE_ACTIONS_DEFAULT));
});

test("defaults reveal both bars on hover, keep user actions on touch and answers in a touch menu", () => {
  assert.equal(USER_MESSAGE_ACTIONS_DEFAULT.reveal, "hover");
  assert.equal(USER_MESSAGE_ACTIONS_DEFAULT.touch, "always");
  assert.deepEqual(
    ASSISTANT_MESSAGE_ACTIONS_DEFAULT.items.filter((item) => item.placement === "bar").map((item) => item.id),
    ["info", "copy"],
  );
  assert.equal(ASSISTANT_MESSAGE_ACTIONS_DEFAULT.reveal, "hover");
  assert.equal(ASSISTANT_MESSAGE_ACTIONS_DEFAULT.touch, "menu");
});

test("both roles configure through the same Settings editor and bar", () => {
  const pages = read("../src/components/settings/pages.tsx");
  assert.match(pages, /<MessageActionsEditor role="user" itemId="chat\.messageActions" \/>/);
  assert.match(pages, /<MessageActionsEditor role="assistant" itemId="chat\.responseActions" \/>/);
  const css = read("../src/components/ChatChrome.css");
  // Hover reveal is opacity-only and an open menu keeps its bar visible.
  assert.match(css, /\.chat-action-bar\[data-reveal="hover"\]\s*\{[^}]*opacity:\s*0;/s);
  assert.match(css, /\.chat-action-bar\[data-reveal="hover"\]\[data-open="true"\]/);
  assert.doesNotMatch(css, /\.chat-action-bar\[data-reveal="hover"\]\s*\{[^}]*(transform|display):/s);
});

test("package buttons are stored, joined and resolved like built-in actions", () => {
  const parsed = parseMessageActionLayout(
    { items: [{ id: "pkg:workflow.message-launcher", placement: "menu" }, { id: "copy", placement: "bar" }, { id: "pkg:../escape", placement: "bar" }] },
    USER_MESSAGE_ACTION_IDS,
    USER_MESSAGE_ACTIONS_DEFAULT,
  );
  assert.deepEqual(parsed.items[0], { id: "pkg:workflow.message-launcher", placement: "menu" },
    "a package entry survives while its package is off");
  assert.equal(parsed.items.some((item) => item.id === "pkg:../escape"), false);
  assert.ok(USER_MESSAGE_ACTION_IDS.includes("pin"), "pinning a prompt is a configurable action");

  const joined = withPackageMessageActions(parsed, [
    { id: "pkg:workflow.message-launcher", menu: true },
    { id: "pkg:handoff.provenance-chip", menu: false },
  ]);
  assert.deepEqual(joined.items.at(-1), { id: "pkg:handoff.provenance-chip", placement: "bar" },
    "an unseen package button joins at the end, on the bar");
  assert.equal(withPackageMessageActions(parsed, []), parsed);

  const chipInMenu = setMessageActionPlacement(joined, "pkg:handoff.provenance-chip", "menu");
  const barOnly = (id: string) => id !== "pkg:handoff.provenance-chip";
  const resolved = resolveMessageActions(chipInMenu, all, false, barOnly);
  assert.deepEqual(resolved.menu.filter((id) => id.startsWith("pkg:")), ["pkg:workflow.message-launcher"]);
  assert.ok(resolved.bar.includes("pkg:handoff.provenance-chip"), "a bar-only button never folds into More");
  const menuOnly = resolveMessageActions({ ...chipInMenu, reveal: "menu" }, all, false, barOnly);
  assert.deepEqual(menuOnly.bar, ["pkg:handoff.provenance-chip"]);
});

test("a package action inherits the placement of the built-in it replaced, else its default", () => {
  const stored = parseMessageActionLayout(
    { items: [{ id: "copy", placement: "bar" }, { id: "multirun", placement: "menu" }], reveal: "hover", touch: "always" },
    USER_MESSAGE_ACTION_IDS,
    USER_MESSAGE_ACTIONS_DEFAULT,
  );
  assert.deepEqual(stored.retired, { multirun: "menu" });
  const joined = withPackageMessageActions(stored, [
    { id: "pkg:multirun.message-user", menu: true, defaultPlacement: "off", replaces: ["multirun"] },
    { id: "pkg:other.off", menu: true, defaultPlacement: "off" },
    { id: "pkg:other.bar", menu: false },
  ]);
  const placement = (id: string) => joined.items.find((item) => item.id === id)?.placement;
  assert.equal(placement("pkg:multirun.message-user"), "menu");
  assert.equal(placement("pkg:other.off"), "off");
  assert.equal(placement("pkg:other.bar"), "bar");
});
