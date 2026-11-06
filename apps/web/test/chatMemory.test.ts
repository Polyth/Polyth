// "Chat memory": which choice applies to a chat, what its card offers, and the
// reminder of a person who compacts by hand.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/", width: 1280, height: 900 });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, getComputedStyle: dom.getComputedStyle.bind(dom),
  matchMedia: dom.matchMedia.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { chatMemoryOverrideFor, chatMemoryReminderDue, chatMemoryState } = await import("../src/chatMemory.ts");
const { default: ChatMemoryCard } = await import("../src/components/ChatMemoryCard.tsx");
const { default: ChatMemoryReminder } = await import("../src/components/ChatMemoryReminder.tsx");
const { default: ChatMemorySection } = await import("../src/components/settings/ChatMemorySection.tsx");
const { buildModel } = await import("../src/reduce.ts");
const { normalizeSettings } = await import("../src/settings.ts");
const { getState, updateSettings } = await import("../src/store.ts");
const { searchSettingsItems } = await import("../src/settings/registry.ts");
const { tr } = await import("../src/i18n/index.ts");
const { api } = await import("@polyth/session/web-api");

const gauge = { known: true, inputTokens: 124_000, contextTokens: 200_000, percent: 62, level: "green", quality: "native" } as const;

async function mount(element: ReturnType<typeof createElement>) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(element));
  return {
    text: () => host.textContent ?? "",
    button: (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label),
    host,
    async click(label: string) {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
      assert.ok(button !== undefined, `button ${label}`);
      await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    },
    unmount: () => act(async () => { root.unmount(); host.remove(); }),
  };
}

function withPreferenceSpy() {
  const calls: unknown[] = [];
  const original = api.setCompactionPreference;
  api.setCompactionPreference = (async (_id: string, preference: unknown) => {
    calls.push(preference);
    return { preference };
  }) as typeof api.setCompactionPreference;
  return { calls, restore: () => { api.setCompactionPreference = original; } };
}

test("the chat's choice wins, a default reaches only ordinary chats, and manual needs a harness that obeys", () => {
  const earlier = { mode: "earlier" } as const;
  assert.deepEqual(chatMemoryState({}, earlier, true).chosen, earlier);
  assert.equal(chatMemoryState({}, earlier, true).overridden, false);
  assert.deepEqual(chatMemoryState({ compactionPreference: { mode: "auto" } }, earlier, true).chosen, { mode: "auto" });
  assert.equal(chatMemoryState({ compactionPreference: { mode: "auto" } }, earlier, true).overridden, true);
  assert.deepEqual(chatMemoryState({ parentId: "parent" }, earlier, true).chosen, { mode: "auto" });
  assert.deepEqual(chatMemoryState({ purpose: "agent" }, earlier, true).chosen, { mode: "auto" });
  const refused = chatMemoryState({}, { mode: "manual" }, false);
  assert.deepEqual(refused.chosen, { mode: "manual" });
  assert.deepEqual(refused.effective, { mode: "auto" });
});

test("picking the default again follows the default instead of copying it", () => {
  assert.equal(chatMemoryOverrideFor({ mode: "earlier" }, { mode: "earlier" }), null);
  assert.deepEqual(chatMemoryOverrideFor({ mode: "auto" }, { mode: "earlier" }), { mode: "auto" });
  assert.deepEqual(chatMemoryOverrideFor({ mode: "custom", percent: 70 }, { mode: "custom", percent: 75 }), { mode: "custom", percent: 70 });
});

test("the reminder waits for manual and a nearly full memory", () => {
  const manual = chatMemoryState({}, { mode: "manual" }, true);
  assert.equal(chatMemoryReminderDue(manual, 74), false);
  assert.equal(chatMemoryReminderDue(manual, 75), true);
  assert.equal(chatMemoryReminderDue(manual, null), false);
  assert.equal(chatMemoryReminderDue(chatMemoryState({}, { mode: "auto" }, true), 99), false);
  assert.equal(chatMemoryReminderDue(chatMemoryState({}, { mode: "manual" }, false), 99), false);
});

test("the setting survives a sync round trip and refuses anything it does not know", () => {
  assert.deepEqual(normalizeSettings({}).compactionDefault, { mode: "auto" });
  assert.deepEqual(normalizeSettings({ compactionDefault: { mode: "custom", percent: 75 } }).compactionDefault, { mode: "custom", percent: 75 });
  assert.deepEqual(normalizeSettings({ compactionDefault: { mode: "later" } }).compactionDefault, { mode: "auto" });
});

test("the card says what will happen, in plain words, and saves a pick for this chat", async () => {
  const spy = withPreferenceSpy();
  const card = await mount(createElement(ChatMemoryCard, {
    sessionId: "s1",
    gauge,
    state: chatMemoryState({}, { mode: "auto" }, true),
    personDefault: { mode: "auto" },
  }));
  try {
    assert.match(card.text(), new RegExp(tr("chatmemory.title")));
    assert.ok(card.text().includes(tr("chatmemory.sayAuto")));
    assert.equal(card.host.querySelector(".chat-memory-mark") === null, true, "auto promises no point on the bar");
    assert.ok(card.text().includes(tr("chatmemory.scopeDefault")));
    await card.click(tr("chatmemory.modeEarlier"));
    assert.deepEqual(spy.calls, [{ mode: "earlier" }]);
  } finally {
    await card.unmount();
    spy.restore();
  }
});

test("manual on a harness that keeps compacting explains itself instead of saving", async () => {
  const spy = withPreferenceSpy();
  const card = await mount(createElement(ChatMemoryCard, {
    sessionId: "s1",
    gauge,
    state: chatMemoryState({}, { mode: "auto" }, false),
    personDefault: { mode: "auto" },
  }));
  try {
    assert.equal(card.button(tr("chatmemory.modeManual"))?.getAttribute("aria-disabled"), "true");
    await card.click(tr("chatmemory.modeManual"));
    assert.deepEqual(spy.calls, []);
    assert.ok(card.text().includes(tr("chatmemory.hintManualUnavailable")));
    assert.ok(card.text().includes(tr("chatmemory.sayAuto")));
  } finally {
    await card.unmount();
    spy.restore();
  }
});

test("a chat with its own choice can go back to the default", async () => {
  const spy = withPreferenceSpy();
  const card = await mount(createElement(ChatMemoryCard, {
    sessionId: "s1",
    gauge,
    state: chatMemoryState({ compactionPreference: { mode: "earlier" } }, { mode: "auto" }, true),
    personDefault: { mode: "auto" },
  }));
  try {
    assert.ok(card.text().includes(tr("chatmemory.sayTarget", { percent: "60%" })));
    assert.ok(card.text().includes(tr("chatmemory.scopeChat")));
    await card.click(tr("chatmemory.useDefault"));
    assert.deepEqual(spy.calls, [null]);
  } finally {
    await card.unmount();
    spy.restore();
  }
});

test("the reminder row offers both ways out, only while it applies", async () => {
  const props = {
    sessionId: "s1",
    projectId: "p1",
    title: "Reports",
    gauge: { ...gauge, inputTokens: 188_000, percent: 94, level: "red" as const },
    idle: true,
    full: false,
    compact: { pending: false, run: () => {} },
  };
  const shown = await mount(createElement(ChatMemoryReminder, { ...props, state: chatMemoryState({}, { mode: "manual" }, true) }));
  assert.ok(shown.button(tr("chatmemory.compactNow")) !== undefined);
  assert.ok(shown.button(tr("chatmemory.newChat")) !== undefined);
  assert.ok(shown.text().includes(tr("chatmemory.reminder", { percent: "94%" })));
  await shown.unmount();
  const hidden = await mount(createElement(ChatMemoryReminder, { ...props, state: chatMemoryState({}, { mode: "auto" }, true) }));
  assert.equal(hidden.button(tr("chatmemory.compactNow")), undefined);
  await hidden.unmount();
});

test("a chat refused for being full says why and how to go on, in any mode", async () => {
  const props = {
    sessionId: "s1",
    projectId: "p1",
    title: "Reports",
    gauge,
    state: chatMemoryState({}, { mode: "auto" }, true),
    full: true,
    compact: { pending: false, run: () => {} },
  };
  const shown = await mount(createElement(ChatMemoryReminder, { ...props, idle: true }));
  assert.ok(shown.text().includes(tr("chatmemory.fullReminder")));
  assert.ok(shown.button(tr("chatmemory.compactNow")) !== undefined);
  assert.equal(shown.host.querySelector(".chat-memory-reminder")?.getAttribute("role"), "alert");
  await shown.unmount();
  const working = await mount(createElement(ChatMemoryReminder, { ...props, idle: false }));
  assert.equal(working.button(tr("chatmemory.compactNow")), undefined);
  await working.unmount();
});

test("a refusal holds until a compaction or a new turn answers it", () => {
  const event = (seq: number, type: string, data: Record<string, unknown>) => ({ sessionId: "s1", seq, time: seq, type, data });
  const refused = [
    event(1, "user/message", { text: "hello" }),
    event(2, "turn/started", { turnId: "t1" }),
    event(3, "turn/stopped", { turnId: "t1", reason: "error", code: "context-full", error: "Prompt is too long" }),
  ];
  assert.equal(buildModel(refused as never).turn?.contextFull, true);
  assert.equal(buildModel([...refused, event(4, "session/compacted", {})] as never).turn?.contextFull, undefined);
  assert.equal(buildModel([
    ...refused,
    event(4, "turn/started", { turnId: "t2" }),
    event(5, "turn/stopped", { turnId: "t2", reason: "completed" }),
  ] as never).turn?.contextFull, undefined);
  assert.equal(buildModel([
    event(1, "turn/started", { turnId: "t1" }),
    event(2, "turn/stopped", { turnId: "t1", reason: "error", code: "unknown" }),
  ] as never).turn?.contextFull, undefined, "any other failure stays an ordinary failure");
});

test("the default is chosen in Settings, where it can also be found by search", async () => {
  updateSettings({ compactionDefault: { mode: "auto" } });
  const section = await mount(createElement(ChatMemorySection));
  try {
    const radios = [...section.host.querySelectorAll("input[type=radio]")];
    assert.equal(radios.length, 3);
    await act(async () => { (radios[0] as unknown as { click(): void }).click(); });
    assert.deepEqual(getState().settings.compactionDefault, { mode: "earlier" });
    assert.ok(section.text().includes("88%"), "the reserve's effect on a small model");
    assert.ok(section.text().includes("95%"), "and on a large one");
    assert.ok(searchSettingsItems("compact", { sessions: "Sessions" }).some((hit) => hit.item.id === "sessions.chatMemory"));
  } finally {
    updateSettings({ compactionDefault: { mode: "auto" } });
    await section.unmount();
  }
});
