import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  localStorage: dom.localStorage,
  location: dom.location,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

register("./tsxHooks.mjs", import.meta.url);

const { listCommands, runCommand } = await import("../src/commands.ts");
const { installShell } = await import("../src/shell.ts");
const { getState, closeWorkspacePane } = await import("../src/store.ts");
const { registerSurface } = await import("../src/surfaces.ts");

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

test.after(() => unregisterTerminal());
