import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import {
  EMPTY_STARTER_CONTEXT,
  starterContextFrom,
  starterSessionContext,
} from "../src/starters.ts";

register("./tsxHooks.mjs", import.meta.url);

const read = (relative: string) =>
  readFile(new URL(relative, import.meta.url), "utf8");

test("session starter context uses real replay-derived history and turn state", () => {
  assert.deepEqual(
    starterSessionContext({ messages: [{ kind: "user" }], turn: { status: "stopped" } }),
    { hasHistory: true, lastTurnFinished: true },
  );
  assert.deepEqual(
    starterContextFrom(null, starterSessionContext({ messages: [], turn: null })),
    EMPTY_STARTER_CONTEXT,
  );
  assert.deepEqual(
    starterSessionContext({ messages: [{ kind: "assistant" }], turn: { status: "working" } }),
    { hasHistory: true, lastTurnFinished: false },
  );
});

test("starter picker is one responsive surface and selection only inserts a draft", async () => {
  const [picker, surface] = await Promise.all([
    read("../src/components/mobile/StarterPicker.tsx"),
    read("../src/components/workspace/builtinSurfaces.tsx"),
  ]);
  assert.match(picker, /<ResponsiveOverlay[\s\S]*desktop="dialog"[\s\S]*sheetSize="tall"/);
  assert.doesNotMatch(picker, /<Sheet\b/);
  assert.match(surface, /onPick=\{\(starter\) => requestComposerInsert\(starter\.prompt\)\}/);
  assert.match(surface, /starterSessionContext\(model\)/);
  assert.doesNotMatch(surface, /onPick=[^\n]*(?:sendMessage|createSession)/);
});

test("starter picker shell command is searchable", async () => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { addEventListener: () => {} },
  });
  const [{ activateProject, setActiveView }, { installShell }, commands] =
    await Promise.all([
      import("../src/store.ts"),
      import("../src/shell.ts"),
      import("../src/commands.ts"),
    ]);
  activateProject("starter-test-project");
  setActiveView("session");
  installShell();
  assert.equal(
    commands.filterPalette(commands.listCommands(), "starter")[0]?.id,
    "cmd.starterPicker",
  );
});
