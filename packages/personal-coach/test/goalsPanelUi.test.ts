// Goal controls and add forms show their result at once and roll back, with
// the typed text kept, when the server refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { CoachGoalDto } from "../widgets/api.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: GoalsPanel } = await import("../widgets/GoalsPanel.tsx");

type Props = Record<string, unknown> & { children?: ReactNode };
// Plain stand-ins for the host primitives the Coach receives.
const ui = {
  Button: ({ children, busy: _busy, variant: _variant, size: _size, ...rest }: Props) =>
    h("button", { type: "button", ...rest }, children),
  TextInput: (props: Props) => h("input", props),
  Textarea: (props: Props) => h("textarea", props),
  Select: ({ value, onChange, options, ariaLabel }: Props) => h("select", {
    value,
    "aria-label": ariaLabel,
    onChange: (event: { target: { value: string } }) => (onChange as (value: string) => void)(event.target.value),
  }, (options as Array<{ value: string; label: string }>).map((item) => h("option", { key: item.value, value: item.value }, item.label))),
  Menu: ({ entries, children }: Props) => h("div", null,
    (children as unknown as (trigger: object) => ReactNode)({}),
    (entries as Array<{ id: string; label: string; disabled?: boolean; onSelect(): void }>).map((entry) =>
      h("button", { key: entry.id, type: "button", "data-entry": entry.id, disabled: entry.disabled, onClick: entry.onSelect }, entry.label))),
};

const client = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  ensureLoaded: async () => {},
  refresh: async () => {},
  talk: async () => {},
};
const snapshot = { status: "ready", busy: new Set<string>() };

const settle = async () => {
  for (let index = 0; index < 3; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

const typeInto = (control: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
  const prototype = control instanceof dom.HTMLTextAreaElement ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
};

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === text) as HTMLButtonElement | undefined;

function mount(api: Record<string, unknown>, selectedGoalId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    api,
    client,
    ui,
    friendlyError: (action: string, cause: unknown) => `${action}: ${(cause as Error).message}`,
    selectedGoalId,
    onSelectGoal: () => {},
  };
  return {
    container,
    render: () => act(async () => { root.render(h(GoalsPanel as never, props as never)); }),
    unmount: () => act(async () => { root.unmount(); container.remove(); }),
  };
}

const goal = (): CoachGoalDto => ({ id: "g1", title: "Run a marathon", status: "active", priority: 2 });
const baseApi = (goals: CoachGoalDto[]) => ({
  goals: async () => goals.map((item) => ({ ...item })),
  commitments: async () => [],
  routines: async () => [],
});

test("a new goal shows as pending at once and keeps its title when the server refuses", async () => {
  let refuse!: (error: Error) => void;
  const titles: string[] = [];
  const view = mount({
    ...baseApi([]),
    createGoal: (input: { title: string }) => {
      titles.push(input.title);
      return new Promise((_resolve, reject) => { refuse = reject; });
    },
  }, null);
  try {
    await view.render();
    await settle();
    const input = view.container.querySelector<HTMLInputElement>("form.coach-add input")!;
    await act(async () => { typeInto(input, "Learn Spanish"); });
    await act(async () => { button(view.container, "Add goal")!.click(); });
    assert.equal(input.value, "", "the field clears at once");
    assert.equal(input.disabled, false);
    assert.match(view.container.querySelector(".coach-row--pending")?.textContent ?? "", /Learn Spanish.*Adding…/);
    await act(async () => { refuse(new Error("offline")); });
    await settle();
    assert.deepEqual(titles, ["Learn Spanish"], "sent once");
    const failed = view.container.querySelector(".coach-row--failed")!;
    assert.match(failed.textContent ?? "", /Not added/);
    assert.match(view.container.textContent ?? "", /Add goal: offline/);
    await act(async () => { button(failed as HTMLElement, "Edit")!.click(); });
    assert.equal(input.value, "Learn Spanish", "the title is back in the field");
    assert.deepEqual(titles, ["Learn Spanish"], "not resent by itself");
  } finally {
    await view.unmount();
  }
});

test("pausing a goal shows it at once and restores it when the server refuses", async () => {
  let refuse!: (error: Error) => void;
  const view = mount({
    ...baseApi([goal()]),
    updateGoal: () => new Promise((_resolve, reject) => { refuse = reject; }),
  }, "g1");
  try {
    await view.render();
    await settle();
    assert.equal(view.container.querySelector(".coach-goal-title .coach-badge--quiet"), null);
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[data-entry="pause"]')!.click(); });
    assert.equal(view.container.querySelector(".coach-goal-title .coach-badge--quiet")?.textContent, "Paused");
    await act(async () => { refuse(new Error("offline")); });
    await settle();
    assert.equal(view.container.querySelector(".coach-goal-title .coach-badge--quiet"), null, "back to active");
    assert.match(view.container.textContent ?? "", /Update goal: offline/);
  } finally {
    await view.unmount();
  }
});

test("a goal edit closes the editor at once and reopens it with the typed text when the server refuses", async () => {
  let refuse!: (error: Error) => void;
  let calls = 0;
  const view = mount({
    ...baseApi([goal()]),
    updateGoal: () => {
      calls += 1;
      return new Promise((_resolve, reject) => { refuse = reject; });
    },
  }, "g1");
  try {
    await view.render();
    await settle();
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[data-entry="edit"]')!.click(); });
    const title = view.container.querySelector<HTMLInputElement>("form.coach-form input")!;
    await act(async () => { typeInto(title, "Run two marathons"); });
    await act(async () => { button(view.container, "Save")!.click(); });
    assert.equal(view.container.querySelector("form.coach-form"), null, "the editor closes at once");
    assert.equal(view.container.querySelector("h2")?.textContent, "Run two marathons");
    await act(async () => { refuse(new Error("offline")); });
    await settle();
    assert.equal(calls, 1);
    assert.equal(view.container.querySelector<HTMLInputElement>("form.coach-form input")?.value, "Run two marathons");
    assert.match(view.container.textContent ?? "", /Save goal: offline/);
  } finally {
    await view.unmount();
  }
});
