import test from "node:test";
import assert from "node:assert/strict";
import {
  commandDescriptorsFromMeta,
  installCommandSlotBridge,
  isPaletteCommandDescriptor,
} from "../src/commandBridge.ts";
import {
  filterPalette,
  listCommands,
  runCommand,
} from "../src/commands.ts";
import { registerSlot } from "../src/slots.ts";

test("command slot descriptors are validated defensively", () => {
  const run = () => {};
  assert.equal(isPaletteCommandDescriptor({
    id: "plugin.open",
    label: "Open plugin",
    keywords: ["extension"],
    icon: "plugin",
    group: "Plugins",
    hint: "Ctrl+O",
    when: () => true,
    run,
  }), true);
  for (const malformed of [
    null,
    {},
    { id: "", label: "Empty id", run },
    { id: "spaces are unsafe", label: "Bad id", run },
    { id: "plugin.missing-run", label: "Missing run" },
    { id: "plugin.bad-keywords", label: "Bad keywords", keywords: "no", run },
    { id: "plugin.bad-when", label: "Bad availability", when: true, run },
  ]) {
    assert.equal(isPaletteCommandDescriptor(malformed), false);
  }
  assert.deepEqual(commandDescriptorsFromMeta({ commands: [
    { id: "plugin.good", label: "Good", run },
    { id: "plugin.bad", label: "Bad" },
  ] }).map((item) => item.id), ["plugin.good"]);
});

test("bridge registers, replaces, disposes, and searches slot commands", () => {
  const uninstall = installCommandSlotBridge();
  let ran = "";
  const offOld = registerSlot(
    "commandPalette.commands",
    "test.palette",
    () => null,
    0,
    { commands: [{
      id: "plugin.bridge-action",
      label: "Deploy café service",
      keywords: ["ship"],
      icon: "plugin",
      run: () => { ran = "old"; },
    }] },
  );
  try {
    assert.equal(
      filterPalette(listCommands(), "cafe")[0]?.id,
      "plugin.bridge-action",
      "slot commands are searchable immediately",
    );
    assert.equal(runCommand("plugin.bridge-action"), true);
    assert.equal(ran, "old");

    const offNew = registerSlot(
      "commandPalette.commands",
      "test.palette",
      () => null,
      0,
      { commands: [{
        id: "plugin.bridge-action",
        label: "Deploy replacement",
        run: () => { ran = "new"; },
      }] },
    );
    try {
      assert.equal(runCommand("plugin.bridge-action"), true);
      assert.equal(ran, "new");
      offOld();
      assert.equal(runCommand("plugin.bridge-action"), true);
      assert.equal(ran, "new", "stale slot disposal keeps the replacement");
    } finally {
      offNew();
    }
    assert.equal(runCommand("plugin.bridge-action"), false);
  } finally {
    offOld();
    uninstall();
  }
});

test("malformed plugin commands and throwing availability checks fail closed", () => {
  const uninstall = installCommandSlotBridge();
  const off = registerSlot(
    "commandPalette.commands",
    "test.malformed",
    () => null,
    0,
    { commands: [
      { id: "plugin.no-handler", label: "No handler" },
      {
        id: "plugin.hidden",
        label: "Hidden",
        when: () => { throw new Error("plugin failure"); },
        run: () => assert.fail("hidden command must not run"),
      },
    ] },
  );
  try {
    assert.equal(runCommand("plugin.no-handler"), false);
    assert.ok(!listCommands().some((command) => command.id === "plugin.hidden"));
    assert.equal(runCommand("plugin.hidden"), false);
  } finally {
    off();
    uninstall();
  }
});
