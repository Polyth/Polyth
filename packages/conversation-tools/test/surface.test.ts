import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (name: string) => readFile(new URL(`../widgets/${name}`, import.meta.url), "utf8");

test("find opens in a modal dialog and leaves no always-visible chat launcher", async () => {
  const [index, component] = await Promise.all([source("index.tsx"), source("ConversationFind.tsx")]);
  // The composer slot only hosts the (initially empty) dialog.
  assert.match(index, /slot: "session\.composer\.before"[\s\S]*?FindDialogHost/);
  assert.doesNotMatch(component, /conversation-find-launcher/);
  assert.match(component, /host\.ui\.Dialog/);
});

test("the placeable launcher is opt-in, composer- and workspace-capable", async () => {
  const index = await source("index.tsx");
  assert.match(index, /id: "conversation\.find"[\s\S]*?kind: "mini-widget"/);
  assert.match(index, /defaultVisible: false/);
  for (const slot of ["composer.leading", "composer.trailing", "workspace.main"]) {
    assert.ok(index.includes(`"${slot}"`), slot);
  }
  // The package supplies its own launcher, so the host must not add a second.
  assert.match(index, /launcherWidget: false/);
});
