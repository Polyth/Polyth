// Settings > Chat reads as a summary: a live preview, one Level of detail, and
// one-line rows that open in place one at a time. These checks pin the level
// mapping onto real preferences, that every searchable chat setting can be
// reached behind its row, and the interactions on the mounted page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import type { ComponentType } from "react";
import { Window } from "happy-dom";
import type { MessageActionLayout, MessageActionItem, MessageActionPlacement } from "../src/messageActionLayout.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { UI_DEFAULTS, getUiSettings, setUiSettings } = await import("../src/uiPrefs.ts");
const { searchSettingsItems } = await import("../src/settings/registry.ts");
const { registerSlot } = await import("../src/slots.ts");
const {
  CHAT_ALWAYS_VISIBLE_ITEMS,
  CHAT_DETAIL_LEVELS,
  CHAT_MORE_ITEMS,
  CHAT_PREVIEW_ROW,
  CHAT_ROW_ITEMS,
  chatDetailLevelOf,
  chatDetailPatch,
  chatItemInMore,
  chatPreviewFocus,
  chatRowOfItem,
} = await import("../src/components/settings/chatSettingsModel.ts");
const { placeMessageAction, USER_MESSAGE_ACTIONS_DEFAULT } = await import("../src/messageActionLayout.ts");
const { ChatPage } = await import("../src/components/settings/ChatSettingsPage.tsx");
const { DisclosureRow } = await import("../src/components/settings/parts.tsx");

type LevelPrefs = Parameters<typeof chatDetailLevelOf>[0];
type ChatPageProps = { settingsTarget?: { itemId?: string } };

function resetPrefs() {
  setUiSettings({
    actionGrouping: UI_DEFAULTS.actionGrouping,
    activityBlockStyle: UI_DEFAULTS.activityBlockStyle,
    thinkingDisplayMode: UI_DEFAULTS.thinkingDisplayMode,
    promptNavigator: UI_DEFAULTS.promptNavigator,
    userMessageActions: UI_DEFAULTS.userMessageActions,
    assistantMessageActions: UI_DEFAULTS.assistantMessageActions,
    showMessageActions: true,
    showAnswerQuickActions: true,
  });
}

async function mount(settingsTarget?: { itemId?: string }) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ChatPage as ComponentType<ChatPageProps>, settingsTarget ? { settingsTarget } : {}));
  });
  return {
    container,
    rerender: (target: { itemId?: string }) => act(async () => {
      root.render(createElement(ChatPage as ComponentType<ChatPageProps>, { settingsTarget: target }));
    }),
    unmount: () => act(async () => { root.unmount(); container.remove(); }),
  };
}

const rowHead = (container: Element, row: string) =>
  container.querySelector<HTMLElement>(`[data-disclosure-row="${row}"] > button`);
const openRows = (container: Element) =>
  [...container.querySelectorAll<HTMLElement>("[data-disclosure-row]")]
    .filter((row) => row.dataset.open === "true")
    .map((row) => row.dataset.disclosureRow);
const hasItem = (container: Element, item: string) =>
  container.querySelector(`[data-settings-item="${item}"]`) !== null;
const click = (element: Element | null) => act(async () => {
  element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
});

test("balanced is exactly the install defaults, so a fresh account reads as Balanced", () => {
  assert.equal(chatDetailLevelOf(UI_DEFAULTS), "balanced");
  const patch = chatDetailPatch("balanced", UI_DEFAULTS);
  assert.equal(patch.actionGrouping, UI_DEFAULTS.actionGrouping);
  assert.equal(patch.activityBlockStyle, UI_DEFAULTS.activityBlockStyle);
  assert.equal(patch.thinkingDisplayMode, UI_DEFAULTS.thinkingDisplayMode);
  assert.equal(patch.promptNavigator, UI_DEFAULTS.promptNavigator);
  assert.deepEqual(patch.userMessageActions, UI_DEFAULTS.userMessageActions);
  assert.deepEqual(patch.assistantMessageActions, UI_DEFAULTS.assistantMessageActions);
});

test("every level round-trips and the three levels really differ", () => {
  const seen = new Set<string>();
  for (const level of CHAT_DETAIL_LEVELS) {
    const patch = chatDetailPatch(level, UI_DEFAULTS);
    assert.equal(chatDetailLevelOf(patch), level);
    seen.add(JSON.stringify([patch.actionGrouping, patch.activityBlockStyle, patch.thinkingDisplayMode, patch.promptNavigator]));
  }
  assert.equal(seen.size, CHAT_DETAIL_LEVELS.length);
});

test("a level changes how buttons reveal but never which buttons exist or their order", () => {
  const custom: LevelPrefs = {
    ...UI_DEFAULTS,
    userMessageActions: {
      ...USER_MESSAGE_ACTIONS_DEFAULT,
      items: [{ id: "pin", placement: "menu" }, { id: "copy", placement: "off" }, { id: "revert", placement: "bar" }, { id: "fork", placement: "bar" }, { id: "session", placement: "bar" }],
    },
  };
  const patch = chatDetailPatch("minimal", custom);
  assert.deepEqual(patch.userMessageActions.items, custom.userMessageActions.items);
  assert.equal(patch.userMessageActions.touch, "menu");
  assert.deepEqual(Object.keys(patch).sort(), [
    "actionGrouping", "activityBlockStyle", "assistantMessageActions", "promptNavigator", "thinkingDisplayMode", "userMessageActions",
  ], "typing and sending are never part of a level");
});

test("one hand-edited setting reads as a custom mix", () => {
  assert.equal(chatDetailLevelOf({ ...UI_DEFAULTS, activityBlockStyle: "ledger" }), null);
  assert.equal(chatDetailLevelOf({ ...UI_DEFAULTS, thinkingDisplayMode: "expanded" }), null);
  assert.equal(chatDetailLevelOf({ ...UI_DEFAULTS, promptNavigator: "off" }), null);
  assert.equal(chatDetailLevelOf({ ...UI_DEFAULTS, userMessageActions: { ...UI_DEFAULTS.userMessageActions, reveal: "always" } }), null);
});

test("ungrouped steps have no style, and a stored always-on rail still counts as on", () => {
  const detailed = chatDetailPatch("detailed", UI_DEFAULTS);
  assert.equal(chatDetailLevelOf({ ...detailed, activityBlockStyle: "ledger" }), "detailed");
  assert.equal(chatDetailLevelOf({ ...UI_DEFAULTS, promptNavigator: "on" }), "balanced");
  assert.equal(chatDetailPatch("balanced", { ...UI_DEFAULTS, promptNavigator: "on" }).promptNavigator, "on",
    "a person's own on-mode survives");
  assert.equal(chatDetailPatch("balanced", { ...UI_DEFAULTS, promptNavigator: "off" }).promptNavigator, "auto");
});

test("every searchable chat setting sits behind a row, under More options or on the page", () => {
  const registry = readFileSync(new URL("../src/settings/registry.ts", import.meta.url), "utf8");
  const targets = [...registry.matchAll(/pageId: "chat",.*focusTarget: "([^"]+)"/g)].map((match) => match[1] as string);
  assert.ok(targets.length >= 20, `found ${targets.length} chat items`);
  for (const target of targets) {
    const placed = chatRowOfItem(target) !== null || chatItemInMore(target) || CHAT_ALWAYS_VISIBLE_ITEMS.includes(target);
    assert.ok(placed, `${target} has no place on the page`);
  }
  const page = readFileSync(new URL("../src/components/settings/ChatSettingsPage.tsx", import.meta.url), "utf8");
  for (const item of [...Object.values(CHAT_ROW_ITEMS).flat(), ...CHAT_MORE_ITEMS, ...CHAT_ALWAYS_VISIBLE_ITEMS]) {
    assert.ok(targets.includes(item), `${item} is not registered for search`);
    assert.ok(page.includes(`itemId="${item}"`), `${item} has no element to land on`);
  }
});

test("search finds a setting by the name its row shows on the page", () => {
  const labels = { chat: "Chat" };
  const finds = (query: string, id: string) => searchSettingsItems(query, labels).some((hit) => hit.item.id === id);
  assert.ok(finds("agent steps", "chat.activityStyle"));
  assert.ok(finds("group steps", "chat.actionBlocks"));
  assert.ok(finds("long pastes", "chat.largePaste"));
  assert.ok(finds("photo size", "chat.imageSize"));
  assert.ok(finds("under your messages", "chat.messageActions"));
  assert.ok(finds("under agent replies", "chat.responseActions"));
  assert.ok(finds("send with", "chat.sendOnEnter"));
  assert.ok(finds("send with", "chat.mobileSendShortcut"));
  assert.ok(finds("level of detail", "chat.detailLevel"));
  assert.ok(finds("minimal", "chat.detailLevel"));
  assert.ok(finds("conversation width", "chat.width"), "the former name still finds it");
});

test("the header numbers setting is gone, and its row is named for what is left", async () => {
  assert.equal(chatRowOfItem("chat.headerMetrics"), null);
  assert.equal(searchSettingsItems("chat metrics", { chat: "Chat" }).some((hit) => hit.item.id === "chat.headerMetrics"), false);
  assert.equal("headerMetrics" in UI_DEFAULTS, false);
  resetPrefs();
  const { container, unmount } = await mount({ itemId: "chat.mobileSessionTitle" });
  try {
    assert.match(rowHead(container, "header")?.textContent ?? "", /Mobile session title/);
    const buttons = [...container.querySelectorAll('[data-settings-item="chat.mobileSessionTitle"] .seg button')];
    assert.deepEqual(buttons.map((button) => button.textContent), ["Hidden", "Title", "Glass button"]);
    await click(buttons[2] ?? null);
    assert.equal(getUiSettings().mobileSessionTitle, "button");
    assert.match(rowHead(container, "header")?.textContent ?? "", /Glass button/, "the summary follows");
  } finally {
    setUiSettings({ mobileSessionTitle: UI_DEFAULTS.mobileSessionTitle });
    await unmount();
  }
});

test("the sample follows the corner rule: controls square with the setting, only dots stay round", () => {
  const page = readFileSync(new URL("../src/components/settings/ChatSettingsPage.css", import.meta.url), "utf8");
  const editor = readFileSync(new URL("../src/components/settings/MessageActionsEditor.css", import.meta.url), "utf8");
  for (const css of [page, editor]) {
    assert.doesNotMatch(css, /border-radius:\s*(50%|999px)/, "--radius-circle names a true circle, --radius-round a pill");
    assert.doesNotMatch(css, /border-radius:\s*\d+px/, "a literal corner ignores the rounding setting");
  }
  assert.match(page, /\.chat-preview-send \{[^}]*border-radius:\s*var\(--radius-round\)/);
  assert.match(page, /\.chat-preview-status i \{[^}]*border-radius:\s*var\(--radius-circle\)/);
  assert.doesNotMatch(page, /data-status-style/, "the status line has one look: text with no plate, as the real one");
});

test("thinking kept in the activity block lights the steps in the preview", () => {
  assert.deepEqual(chatPreviewFocus("thinking", { thinkingDisplayMode: "collapsed" }), ["thinking"]);
  assert.deepEqual(chatPreviewFocus("thinking", { thinkingDisplayMode: "activity" }), ["steps"]);
  assert.deepEqual(chatPreviewFocus(null, { thinkingDisplayMode: "collapsed" }), []);
});

test("placing a button moves it within one lane and leaves the others' slots alone", () => {
  const layout: MessageActionLayout<string> = {
    items: [
      { id: "a", placement: "bar" },
      { id: "b", placement: "off" },
      { id: "c", placement: "bar" },
      { id: "d", placement: "menu" },
    ],
    reveal: "hover",
    touch: "always",
  };
  const order = (next: MessageActionLayout<string>) => next.items.map((item) => `${item.id}:${item.placement}`);
  assert.deepEqual(order(placeMessageAction(layout, "c", "bar", 0)), ["c:bar", "a:bar", "b:off", "d:menu"]);
  assert.deepEqual(order(placeMessageAction(layout, "a", "bar", 9)), ["b:off", "c:bar", "a:bar", "d:menu"], "past the end clamps after the lane's last");
  assert.deepEqual(order(placeMessageAction(layout, "a", "menu", 0)), ["b:off", "c:bar", "a:menu", "d:menu"]);
  assert.deepEqual(order(placeMessageAction(layout, "d", "off", 1)), ["a:bar", "b:off", "d:off", "c:bar"]);
  const noBar: MessageActionLayout<string> = { ...layout, items: layout.items.map((item) => ({ ...item, placement: "off" })) };
  assert.deepEqual(order(placeMessageAction(noBar, "b", "bar", 0)), ["a:off", "c:off", "d:off", "b:bar"], "an empty lane starts at the end");
  assert.equal(placeMessageAction(layout, "missing", "bar", 0), layout);
  const barOnly = (item: MessageActionItem<string>): MessageActionPlacement => (item.id === "d" ? "bar" : item.placement);
  assert.deepEqual(order(placeMessageAction(layout, "a", "bar", 2, barOnly)), ["b:off", "c:bar", "d:menu", "a:bar"],
    "a bar-only button stored as menu counts in the bar lane");
});

test("rows open in place, one at a time, and a closed row renders no settings", async () => {
  resetPrefs();
  const { container, unmount } = await mount();
  try {
    assert.deepEqual(openRows(container), []);
    assert.equal(hasItem(container, "chat.thinking"), false, "a closed row renders no settings");
    assert.equal(hasItem(container, "chat.width"), true, "the width sits on the line itself");
    const steps = rowHead(container, "steps");
    assert.equal(steps?.getAttribute("aria-expanded"), "false");
    await click(steps);
    assert.deepEqual(openRows(container), ["steps"]);
    assert.equal(rowHead(container, "steps")?.getAttribute("aria-expanded"), "true");
    assert.equal(hasItem(container, "chat.actionBlocks"), true);
    await click(rowHead(container, "thinking"));
    assert.deepEqual(openRows(container), ["thinking"]);
    assert.equal(hasItem(container, "chat.actionBlocks"), false, "the other row closed");
    await click(rowHead(container, "thinking"));
    assert.deepEqual(openRows(container), []);
    assert.equal(hasItem(container, "chat.thinking"), false, "toggling closes it again");
  } finally {
    await unmount();
  }
});

test("a routed target opens its row or More options at once, so it can be scrolled to", async () => {
  resetPrefs();
  const mounted = await mount({ itemId: "chat.pinLatestPrompt" });
  const { container } = mounted;
  try {
    assert.deepEqual(openRows(container), ["navigation"], "a deep link on first render");
    assert.equal(hasItem(container, "chat.pinLatestPrompt"), true);
    assert.equal(container.querySelector('[data-disclosure-row="navigation"]')?.getAttribute("data-motion"), null,
      "a routed row does not animate, so its setting is at its final place");
    await mounted.rerender({ itemId: "chat.responseActions" });
    assert.deepEqual(openRows(container), ["replies"], "a later search hit");
    assert.equal(hasItem(container, "chat.responseActions"), true);
    assert.equal(hasItem(container, "chat.promptHistoryLimit"), false);
    await mounted.rerender({ itemId: "chat.promptHistoryLimit" });
    assert.equal(hasItem(container, "chat.promptHistoryLimit"), true, "More options opens for its settings");
    assert.equal(hasItem(container, "chat.copyFormat"), true);
  } finally {
    await mounted.unmount();
  }
});

test("level tiles write the preferences, a hand edit reads Custom and Reset returns to Balanced", async () => {
  resetPrefs();
  const { container, unmount } = await mount();
  const tile = (name: string) => [...container.querySelectorAll(".chat-level-tiles button")]
    .find((button) => button.textContent?.includes(name)) ?? null;
  const pressed = () => [...container.querySelectorAll('.chat-level-tiles button[aria-pressed="true"]')].map((button) => button.querySelector("strong")?.textContent);
  const reset = () => container.querySelector<HTMLButtonElement>(".settings-reset-link");
  try {
    assert.deepEqual(pressed(), ["Balanced"]);
    assert.equal(reset()?.disabled, true, "Reset never offers a no-op");
    await click(tile("Detailed"));
    assert.equal(getUiSettings().actionGrouping, "ungrouped");
    assert.equal(getUiSettings().thinkingDisplayMode, "expanded");
    assert.deepEqual(pressed(), ["Detailed"]);
    await click(tile("Minimal"));
    assert.equal(getUiSettings().activityBlockStyle, "chip");
    assert.equal(getUiSettings().thinkingDisplayMode, "activity");
    assert.equal(getUiSettings().promptNavigator, "off");
    await act(async () => { setUiSettings({ activityBlockStyle: "ledger" }); });
    assert.deepEqual(pressed(), [], "no tile claims a hand-made mix");
    assert.match(container.querySelector(".chat-level-custom")?.textContent ?? "", /Custom/);
    assert.equal(reset()?.disabled, false);
    await click(reset());
    assert.deepEqual(pressed(), ["Balanced"]);
    assert.equal(getUiSettings().activityBlockStyle, "thread");
    assert.equal(container.querySelector(".chat-level-custom") === null, true);
  } finally {
    resetPrefs();
    await unmount();
  }
});

test("the preview follows the preferences, dims around an open row and opens a clicked part's row", async () => {
  resetPrefs();
  const { container, unmount } = await mount();
  const steps = () => container.querySelector<HTMLElement>(".chat-preview-steps");
  const part = (id: string) => container.querySelector<HTMLElement>(`.chat-preview-part[data-part="${id}"]`);
  try {
    assert.equal(steps()?.dataset.style, "thread");
    await act(async () => { setUiSettings({ activityBlockStyle: "ledger" }); });
    assert.equal(steps()?.dataset.style, "ledger");
    await act(async () => { setUiSettings({ actionGrouping: "ungrouped" }); });
    assert.equal(steps()?.dataset.style, "ungrouped");
    resetPrefs();
    assert.equal(container.querySelector(".chat-preview")?.getAttribute("data-focus"), null, "nothing dims at rest");
    await click(part("thinking"));
    assert.deepEqual(openRows(container), ["thinking"], "a click on a part opens its row");
    assert.equal(container.querySelector(".chat-preview")?.getAttribute("data-focus"), "true");
    assert.equal(part("thinking")?.dataset.focused, "true");
    assert.equal(part("answer")?.dataset.focused, undefined);
    await click(part("thinking"));
    assert.deepEqual(openRows(container), ["thinking"], "a second click on the preview keeps it open");
    await click(container.querySelector('.chat-preview-send'));
    assert.deepEqual(openRows(container), ["send"], "the send button opens its own row, not the composer's");
    assert.equal(part("composer")?.dataset.focused, "true", "the composer stays lit around it");
    assert.match(part("composer")?.textContent ?? "", /Enter/, "the send key shows, having no look of its own");
    for (const row of Object.values(CHAT_PREVIEW_ROW)) assert.ok(rowHead(container, row), `no row for ${row}`);
  } finally {
    resetPrefs();
    await unmount();
  }
});

test("the sample is a pointer shortcut: hidden from assistive technology, no focus stop", async () => {
  resetPrefs();
  const { container, unmount } = await mount();
  try {
    const stage = container.querySelector(".chat-preview-stage");
    assert.equal(stage?.getAttribute("aria-hidden"), "true");
    assert.equal(stage?.querySelectorAll("button, a, input, select, textarea, [tabindex]").length, 0);
    assert.equal(container.querySelectorAll(".chat-preview-devices button").length, 2, "the device choice stays reachable");
  } finally {
    await unmount();
  }
});

test("a package button joins the lanes, and a bar-only one skips the menu it cannot live in", async () => {
  resetPrefs();
  const offBarOnly = registerSlot("session.message.actions", "test.bar-only", () => null, 10, { messageAction: { label: "Provenance" } });
  const offMenu = registerSlot("session.message.actions", "test.menu-capable", () => null, 11, { messageAction: { label: "Launch", menu: true } });
  const { container, unmount } = await mount({ itemId: "chat.messageActions" });
  const chip = (id: string) => container.querySelector<HTMLElement>(`[data-action-chip="pkg:${id}"]`);
  const press = (id: string, key: string) => act(async () => {
    chip(id)?.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
  });
  const placement = (id: string) => getUiSettings().userMessageActions.items.find((item) => item.id === `pkg:${id}`)?.placement;
  try {
    assert.equal(chip("test.bar-only")?.textContent, "Provenance");
    assert.equal(chip("test.bar-only")?.dataset.placement, "bar", "an unseen package button joins on the bar");
    await press("test.bar-only", "ArrowDown");
    assert.equal(placement("test.bar-only"), "off", "down skips the menu lane");
    await press("test.bar-only", "ArrowUp");
    assert.equal(placement("test.bar-only"), "bar");
    await press("test.menu-capable", "ArrowDown");
    assert.equal(placement("test.menu-capable"), "menu", "a menu-capable button stops there");

    await click(chip("test.bar-only"));
    assert.equal(document.querySelector('[role="menu"] [data-menu-entry="off"]') !== null, true);
    assert.equal(document.querySelector('[role="menu"] [data-menu-entry="menu"]') === null, true, "its own menu offers no such lane");
    assert.match(document.querySelector(".mqa-chip-detail")?.textContent ?? "", /stays on the bar/);
    await click(document.querySelector('[role="menu"] [data-menu-entry="off"]'));
    assert.equal(placement("test.bar-only"), "off");
  } finally {
    offBarOnly();
    offMenu();
    resetPrefs();
    await unmount();
  }
});

test("buttons move between lanes from the keyboard", async () => {
  resetPrefs();
  const { container, unmount } = await mount({ itemId: "chat.messageActions" });
  const chip = (id: string) => container.querySelector<HTMLElement>(`[data-action-chip="${id}"]`);
  const press = (id: string, key: string) => act(async () => {
    chip(id)?.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
  });
  const placement = (id: string) => getUiSettings().userMessageActions.items.find((item) => item.id === id)?.placement;
  try {
    assert.equal(chip("copy")?.dataset.placement, "bar");
    await press("copy", "ArrowDown");
    assert.equal(placement("copy"), "menu");
    assert.equal(chip("copy")?.dataset.placement, "menu");
    await press("copy", "ArrowDown");
    assert.equal(placement("copy"), "off");
    await press("copy", "ArrowDown");
    assert.equal(placement("copy"), "off", "the last lane holds it");
    await press("copy", "ArrowUp");
    await press("copy", "ArrowUp");
    assert.equal(placement("copy"), "bar");
    const bar = () => getUiSettings().userMessageActions.items.filter((item) => item.placement === "bar").map((item) => item.id);
    const before = bar();
    const last = before.at(-1) as string;
    await press(last, "ArrowLeft");
    assert.deepEqual(bar(), [...before.slice(0, -2), last, before.at(-2)], "left moves it one place earlier in its lane");
    await press(last, "ArrowRight");
    assert.deepEqual(bar(), before);
    await press(before[0] as string, "ArrowLeft");
    assert.deepEqual(bar(), before, "the first in its lane stays");
    assert.match(container.querySelector(".mqa-status")?.textContent ?? "", /position/);
  } finally {
    resetPrefs();
    await unmount();
  }
});

test("a mouse drags a button across lanes, and the click ending the drag opens no menu", async () => {
  resetPrefs();
  const { container, unmount } = await mount({ itemId: "chat.messageActions" });
  const chip = (id: string) => container.querySelector<HTMLElement>(`[data-action-chip="${id}"]`);
  // happy-dom has no layout: give each lane and chip a box, as a browser would.
  const box = (element: Element, top: number, left: number, height: number, width: number) => {
    (element as HTMLElement).getBoundingClientRect = () => ({
      top, left, bottom: top + height, right: left + width, width, height, x: left, y: top, toJSON: () => ({}),
    });
  };
  const pointer = (type: string, target: EventTarget, init: { clientX: number; clientY: number; button?: number; pointerType?: string }) => act(async () => {
    const event = new window.MouseEvent(type, { bubbles: true, button: init.button ?? 0, clientX: init.clientX, clientY: init.clientY });
    Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
    target.dispatchEvent(event as unknown as Event);
  });
  try {
    const lanes = [...container.querySelectorAll('[data-disclosure-row="userActions"] [data-lane]')];
    assert.equal(lanes.length, 3);
    lanes.forEach((lane, index) => {
      box(lane, 100 + index * 50, 0, 40, 400);
      [...lane.querySelectorAll("[data-action-chip]")].forEach((node, position) => box(node, 100 + index * 50, position * 60, 40, 50));
    });
    const hidden = () => getUiSettings().userMessageActions.items.filter((item) => item.placement === "off").map((item) => item.id);
    assert.deepEqual(hidden(), []);
    await pointer("pointerdown", chip("fork")!, { clientX: 130, clientY: 110 });
    await pointer("pointermove", window as unknown as EventTarget, { clientX: 131, clientY: 111 });
    assert.equal(chip("fork")?.dataset.dragging, undefined, "under the threshold it is still a click");
    await pointer("pointermove", window as unknown as EventTarget, { clientX: 130, clientY: 215 });
    assert.equal(chip("fork")?.dataset.dragging, "true");
    assert.deepEqual(hidden(), ["fork"], "it moves into the lane under the pointer");
    await pointer("pointerup", window as unknown as EventTarget, { clientX: 130, clientY: 215 });
    assert.equal(chip("fork")?.dataset.dragging, undefined);
    await click(chip("fork"));
    assert.equal(document.querySelector('[role="menu"]') === null, true, "the click that ended the drag opens nothing");
    assert.match(container.querySelector(".mqa-status")?.textContent ?? "", /position 1 of 1/);
    await click(chip("fork"));
    assert.equal(document.querySelector('[role="menu"]') !== null, true, "a plain click opens its menu");
    await click(document.querySelector('[role="menu"] [data-menu-entry="bar"]'));
    assert.deepEqual(hidden(), [], "the menu moves it without a drag");
  } finally {
    resetPrefs();
    await unmount();
  }
});

test("a finger scrolls from a button's body and only its grip starts a drag", async () => {
  resetPrefs();
  const { container, unmount } = await mount({ itemId: "chat.messageActions" });
  const chip = () => container.querySelector<HTMLElement>('[data-action-chip="fork"]');
  const pointer = (type: string, target: EventTarget, clientY: number) => act(async () => {
    const event = new window.MouseEvent(type, { bubbles: true, clientX: 10, clientY });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    target.dispatchEvent(event as unknown as Event);
  });
  try {
    await pointer("pointerdown", chip()!.querySelector(".mqa-chip-name")!, 10);
    await pointer("pointermove", window as unknown as EventTarget, 60);
    assert.equal(chip()?.dataset.dragging, undefined, "a swipe on the body is the page's");
    await pointer("pointerup", window as unknown as EventTarget, 60);
    await pointer("pointerdown", chip()!.querySelector(".mqa-chip-grip")!, 10);
    await pointer("pointermove", window as unknown as EventTarget, 60);
    assert.equal(chip()?.dataset.dragging, "true");
    await pointer("pointerup", window as unknown as EventTarget, 60);
  } finally {
    resetPrefs();
    await unmount();
  }
});

test("a reveal change and the master switch still write the same preferences", async () => {
  resetPrefs();
  const { container, unmount } = await mount({ itemId: "chat.responseActions" });
  const segButton = (label: string) => [...container.querySelectorAll('[data-disclosure-row="replies"] .seg button')]
    .find((button) => button.textContent === label) ?? null;
  try {
    await click(segButton("Always"));
    assert.equal(getUiSettings().assistantMessageActions.reveal, "always");
    assert.match(rowHead(container, "replies")?.textContent ?? "", /always visible/, "the summary line follows");
    const master = container.querySelector('[data-settings-item="chat.responseActions"] [role="switch"]');
    await click(master);
    assert.equal(getUiSettings().showAnswerQuickActions, false);
    assert.match(rowHead(container, "replies")?.textContent ?? "", /Off/);
    assert.equal(container.querySelector<HTMLButtonElement>('[data-disclosure-row="replies"] [data-action-chip="copy"]')?.disabled, true,
      "the lanes lock while the bar is off");
  } finally {
    resetPrefs();
    await unmount();
  }
});

test("a row reports it has opened only once its panel has finished growing", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let running: Array<{ finished: Promise<void> }> = [{ finished }];
  const proto = window.HTMLElement.prototype as unknown as { getAnimations?: () => unknown[] };
  proto.getAnimations = () => running;
  let opened = 0;
  const render = (open: boolean, animate = true) => act(async () => {
    root.render(createElement(DisclosureRow, { label: "Row", value: "Value", open, animate, onOpened: () => { opened += 1; } }, createElement("i", { id: "inside" })));
  });
  try {
    await render(false);
    await render(true);
    assert.equal(container.querySelector("[data-motion]")?.getAttribute("data-motion"), "opening");
    assert.equal(opened, 0, "a fixed delay would measure a row still growing");
    await act(async () => { finish(); await finished; });
    assert.equal(opened, 1);
    assert.equal(container.querySelector("[data-motion]") === null, true);
    running = [];
    await render(false);
    assert.equal(opened, 1, "closing is not opening");
    await render(true, false);
    assert.equal(opened, 1, "a routed row is scrolled to by the routed target, not by this");
    assert.equal(container.querySelector("#inside") !== null, true);
  } finally {
    delete proto.getAnimations;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("opening a row brings the whole of it into view, not just its first frame", async () => {
  resetPrefs();
  const { container, unmount } = await mount();
  const pane = document.createElement("div");
  pane.className = "settings-pane-body";
  const scrolls: number[] = [];
  (pane as unknown as { scrollBy: (options: { top: number }) => void }).scrollBy = (options) => { scrolls.push(options.top); };
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 900, width: 900, height: 800, x: 0, y: 0, toJSON: () => ({}) });
  container.parentElement?.insertBefore(pane, container);
  pane.append(container);
  const row = container.querySelector<HTMLElement>('[data-disclosure-row="replies"]')!;
  row.getBoundingClientRect = () => ({ top: 730, bottom: 1140, left: 0, right: 500, width: 500, height: 410, x: 0, y: 730, toJSON: () => ({}) });
  try {
    await click(rowHead(container, "replies"));
    assert.deepEqual(openRows(container), ["replies"]);
    assert.deepEqual(scrolls, [1140 - 800 + 8], "scrolled by the row's overflow past the pane");
    await click(rowHead(container, "replies"));
    assert.deepEqual(scrolls.length, 1, "closing does not scroll");
  } finally {
    container.parentElement?.parentElement?.append(container);
    pane.remove();
    resetPrefs();
    await unmount();
  }
});

test("a disclosure row settles without an animation to wait for, and a control row never opens", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (open: boolean) => act(async () => {
    root.render(createElement(DisclosureRow, { label: "Row", value: "Value", open, rowId: "r" }, createElement("i", { id: "inside" })));
  });
  try {
    await render(true);
    assert.equal(container.querySelector("#inside") !== null, true);
    await render(false);
    assert.equal(container.querySelector("#inside") === null, true, "no animation running: it unmounts at once");
    await act(async () => {
      root.render(createElement(DisclosureRow, { label: "Row", itemId: "x", control: createElement("b") }));
    });
    assert.equal(container.querySelector("button") === null, true);
    assert.equal(container.querySelector('[data-settings-item="x"]') !== null, true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
