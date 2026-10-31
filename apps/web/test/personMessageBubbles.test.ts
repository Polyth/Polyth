// Mounted check: people's messages render as chat bubbles. One's own sit at
// the inline end; a run shares one name (first bubble) and one mark and tail
// (last bubble); a time divider opens each stretch; a one-to-one conversation
// names nobody, a second other voice names every run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { JsonObject, SessionEvent } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
dom.localStorage.setItem("polyth.activeAccount", "usr_ann");

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Timeline } = await import("../src/components/Timeline.tsx");
const { activateProject, activateSession, applyEvent, getState, reduceSessionModel, setSessions } = await import("../src/store.ts");

const ANN = { userId: "usr_ann", name: "Ann Lee" };
const BEA = { userId: "usr_bea", name: "Bea" };
const CY = { userId: "usr_cy", name: "Cy" };
const start = Date.UTC(2026, 9, 13, 9, 0);

async function mount(sessionId: string, messages: Array<[number, typeof ANN, string]>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    activateProject("family");
    setSessions("family", [{ id: sessionId, projectId: "family", title: "Talk", status: "idle", purpose: "conversation", createdAt: 1, updatedAt: 1 }]);
    activateSession(sessionId);
    messages.forEach(([minute, author, text], index) => applyEvent({
      id: `${sessionId}-${index + 1}`, sessionId, seq: index + 1, time: start + minute * 60_000,
      type: "person/message", data: { text, author, mentions: [] } as JsonObject, v: 1,
    } satisfies SessionEvent));
    root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
  });
  return {
    host,
    async unmount() {
      await act(async () => { activateSession(null); setSessions("family", []); });
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const rowsOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".msg.person-message")].map((row) => ({
  own: row.classList.contains("is-own"),
  continued: row.classList.contains("is-continued"),
  author: row.querySelector(".person-message-author")?.textContent ?? null,
  mark: row.querySelector(".person-message-mark")?.textContent ?? null,
  // The words alone: in a group the run's first bubble also opens with its
  // author's name.
  text: [...(row.querySelector(".person-message-text")?.childNodes ?? [])]
    .filter((node) => !(node as Element).classList?.contains("person-message-author"))
    .map((node) => node.textContent).join(""),
}));

test("a one-to-one conversation shows bubbles without names", async () => {
  const view = await mount("pair", [[0, ANN, "HI"], [18, BEA, "what's up?"], [18, BEA, "XD"], [19, ANN, "nada"]]);
  try {
    assert.deepEqual(rowsOf(view.host), [
      { own: true, continued: false, author: null, mark: null, text: "HI" },
      { own: false, continued: true, author: null, mark: null, text: "what's up?" },
      { own: false, continued: false, author: null, mark: null, text: "XD" },
      { own: true, continued: false, author: null, mark: null, text: "nada" },
    ]);
    // The first message and the one after a quiet stretch open with a divider.
    const dividers = [...view.host.querySelectorAll(".person-message-divider")];
    assert.equal(dividers.length, 2);
    assert.equal(dividers[0]!.nextElementSibling?.getAttribute("data-message-seq"), "1");
    assert.equal(dividers[1]!.nextElementSibling?.getAttribute("data-message-seq"), "2");
    // Every bubble keeps its exact time for the pointer and screen readers.
    assert.equal(view.host.querySelectorAll(".person-message-line > .person-message-time").length, 4);
  } finally {
    await view.unmount();
  }
});

test("a second other voice names each run and marks its last bubble", async () => {
  const view = await mount("group", [[0, BEA, "one"], [1, BEA, "two"], [2, CY, "👍"], [3, ANN, "mine"]]);
  try {
    assert.deepEqual(rowsOf(view.host), [
      { own: false, continued: true, author: "Bea", mark: null, text: "one" },
      { own: false, continued: false, author: null, mark: "B", text: "two" },
      { own: false, continued: false, author: "Cy", mark: "C", text: "👍" },
      { own: true, continued: false, author: null, mark: null, text: "mine" },
    ]);
    const emoji = view.host.querySelector<HTMLElement>(".msg.person-message[data-message-seq='3'] .person-message-text");
    assert.equal(emoji?.classList.contains("is-emoji"), true);
    assert.equal(emoji?.dataset.emoji, "1");
    // Each voice has its own colour: on its name (inside the run's first
    // bubble) and on its monogram; one's own bubbles carry none.
    const toneOf = (seq: number, part: string) => view.host
      .querySelector(`.msg.person-message[data-message-seq='${seq}'] ${part}`)?.getAttribute("data-person-tone") ?? null;
    assert.equal(Boolean(view.host.querySelector(".msg.person-message[data-message-seq='1'] .person-message-text > .person-message-author")), true);
    const bea = toneOf(1, ".person-message-author");
    assert.notEqual(bea, null);
    assert.equal(toneOf(2, ".person-message-mark"), bea, "the name and the mark of one person match");
    assert.notEqual(toneOf(3, ".person-message-author"), bea, "two people never share a colour");
    assert.equal(toneOf(3, ".person-message-mark"), toneOf(3, ".person-message-author"));
    assert.equal(view.host.querySelector(".msg.person-message.is-own [data-person-tone]"), null);
  } finally {
    await view.unmount();
  }
});
