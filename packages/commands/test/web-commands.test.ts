// WP13: palette command registry — live hints, keywords, checked state,
// diacritic folding, and disposal after plugin removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commandHint, filterPalette, foldText, listCommands, registerCommand, runCommand,
  type PaletteCommand,
} from "../../../apps/web/src/commands.ts";

const cmd = (over: Partial<PaletteCommand> & { id: string; label: string }): PaletteCommand => ({
  run: () => {},
  ...over,
});

test("foldText strips diacritics and case", () => {
  assert.equal(foldText("DÉPLOYER Côté"), "deployer cote");
});

test("filterPalette matches label, id, group, keywords, and resolved hint", () => {
  const all = [
    cmd({ id: "a.one", label: "Déployer serveur", group: "Ops" }),
    cmd({ id: "b.two", label: "Other", keywords: ["quick open", "goto"] }),
    cmd({ id: "c.three", label: "Third", hint: () => "Ctrl+Shift+E" }),
    cmd({ id: "d.four", label: "Fourth", hint: "⌘K" }),
  ];
  assert.deepEqual(filterPalette(all, "deployer").map((c) => c.id), ["a.one"]);
  assert.deepEqual(filterPalette(all, "ops").map((c) => c.id), ["a.one"]);
  assert.deepEqual(filterPalette(all, "quick").map((c) => c.id), ["b.two"]);
  assert.deepEqual(filterPalette(all, "ctrl+shift").map((c) => c.id), ["c.three"]);
  assert.deepEqual(filterPalette(all, "⌘k").map((c) => c.id), ["d.four"]);
  assert.equal(filterPalette(all, "").length, 4);
  assert.deepEqual(filterPalette(all, "zzz"), []);
});

test("commandHint resolves live functions and survives resolver errors", () => {
  let binding = "mod+k";
  const live = cmd({ id: "h.live", label: "x", hint: () => binding });
  assert.equal(commandHint(live), "mod+k");
  binding = "mod+shift+k"; // user rebinding must show through
  assert.equal(commandHint(live), "mod+shift+k");
  assert.equal(commandHint(cmd({ id: "h.static", label: "x", hint: "F5" })), "F5");
  assert.equal(commandHint(cmd({ id: "h.none", label: "x" })), undefined);
  assert.equal(commandHint(cmd({ id: "h.boom", label: "x", hint: () => { throw new Error("boom"); } })), undefined);
});

test("checked commands surface state; when() hides commands", () => {
  let mode = "folder";
  const dispose = registerCommand(cmd({
    id: "test.group", label: "Group by: Folder",
    checked: () => mode === "folder",
    run: () => { mode = "folder"; },
  }));
  const disposeHidden = registerCommand(cmd({ id: "test.hidden", label: "hidden", when: () => false }));
  try {
    const visible = listCommands();
    assert.ok(visible.some((c) => c.id === "test.group"));
    assert.ok(!visible.some((c) => c.id === "test.hidden"));
    const found = visible.find((c) => c.id === "test.group")!;
    assert.equal(found.checked?.(), true);
    mode = "flat";
    assert.equal(found.checked?.(), false);
  } finally {
    dispose();
    disposeHidden();
  }
});

test("runCommand of a disposed (plugin-removed) command returns false", () => {
  let ran = 0;
  const dispose = registerCommand(cmd({ id: "test.run", label: "r", run: () => { ran++; } }));
  assert.equal(runCommand("test.run"), true);
  assert.equal(ran, 1);
  dispose();
  assert.equal(runCommand("test.run"), false);
  assert.equal(ran, 1);
  assert.equal(runCommand("never.existed"), false);
});

test("command icon metadata round-trips without changing search behavior", () => {
  const dispose = registerCommand(cmd({
    id: "test.icon",
    label: "Search conversations",
    icon: "search",
  }));
  try {
    const found = listCommands().find((command) => command.id === "test.icon");
    assert.equal(found?.icon, "search");
    assert.deepEqual(filterPalette([found!], "conversations"), [found]);
  } finally {
    dispose();
  }
});
