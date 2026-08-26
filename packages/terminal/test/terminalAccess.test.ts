import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
  location: dom.location,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Reproduce a legacy client that persisted the former default explicitly.
dom.localStorage.setItem("polyth.hotkeys", JSON.stringify({ viewTerminal: "mod+j" }));

register("./tsxHooks.mjs", import.meta.url);

const { listCommands, runCommand } = await import("../../../apps/web/src/commands.ts");
const { installShell } = await import("../../../apps/web/src/shell.ts");
const { getState, closeWorkspacePane } = await import("../../../apps/web/src/store.ts");
const { registerSurface } = await import("../../../apps/web/src/surfaces.ts");
const { webPackageHost } = await import("../../../apps/web/src/packages/webHost.ts");
const { default: terminalEntry } = await import("../widgets/index.tsx");
terminalEntry(webPackageHost)();

const unregisterTerminal = registerSurface({
  id: "terminal",
  title: "Terminal",
  capabilityId: "terminal",
  order: 3,
  component: () => null,
  presentation: {
    kind: "workspace",
    defaultRatio: 0.6,
    minWidth: 380,
    preferredMaxWidth: 760,
    keepAlive: true,
    escape: "content",
  },
});
installShell();

test("command palette exposes Open Terminal with its live shortcut hint", () => {
  const command = listCommands().find((candidate) => candidate.id === "capability.terminal");
  assert.ok(command);
  assert.equal(command.label, "Open Terminal");
  assert.equal(typeof command.hint === "function" ? command.hint() : command.hint, "Ctrl+`");

  assert.equal(runCommand(command.id), true);
  assert.equal(getState().railPlugin, "terminal");
  closeWorkspacePane();
});

test("Ctrl+` toggles the Terminal pane", () => {
  dom.dispatchEvent(new dom.KeyboardEvent("keydown", {
    key: "j",
    ctrlKey: true,
    bubbles: true,
  }));
  assert.equal(getState().railPlugin, null, "the retired Ctrl+J default does nothing");

  const key = () => dom.dispatchEvent(new dom.KeyboardEvent("keydown", {
    key: "`",
    ctrlKey: true,
    bubbles: true,
  }));

  key();
  assert.equal(getState().railPlugin, "terminal");
  key();
  assert.equal(getState().railPlugin, null);
});

test("focused terminal owns Ctrl+Shift+F while Ctrl+` still reaches the shell", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createTerminalEmulator } = await import("../widgets/terminal/emulator.ts");
  const { default: TermPane } = await import("../widgets/TermPane.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const sent: string[] = [];

  await act(async () => {
    root.render(createElement(TermPane, {
      emu: createTerminalEmulator({ cols: 40, rows: 8 }),
      label: "QA shell",
      running: true,
      send: (data: string) => sent.push(data),
      onResize: () => {},
    }));
  });

  try {
    const body = container.querySelector<HTMLElement>(".term-body");
    assert.ok(body);
    const find = new dom.KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      body.dispatchEvent(find as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(find.defaultPrevented, true);
    assert.ok(container.querySelector(".term-search"), "terminal search opens");
    assert.equal(getState().overlay, null, "Session history stays closed");

    await act(async () => {
      body.focus();
      body.dispatchEvent(new dom.KeyboardEvent("keydown", {
        key: "`",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }) as unknown as Event);
    });
    assert.equal(getState().railPlugin, "terminal");
    assert.deepEqual(sent, [], "the shell shortcut is not sent to the PTY");
    closeWorkspacePane();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test.after(() => unregisterTerminal());
