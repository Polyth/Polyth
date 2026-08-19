import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandService } from "@polyth/commands";

function make() {
  const home = mkdtempSync(join(tmpdir(), "polyth-cmd-home-"));
  const root = mkdtempSync(join(tmpdir(), "polyth-cmd-root-"));
  return { svc: createCommandService({ home }), home, root };
}

test("saveCommand writes frontmatter markdown that list() reads back", async () => {
  const { svc, root } = make();
  await svc.saveCommand(root, "project", {
    name: "deploy",
    description: "Ship it",
    prompt: "Deploy the app to $ARGUMENTS",
    agent: "build",
  });
  const { commands } = await svc.list(root);
  const cmd = commands.find((c) => c.name === "deploy");
  assert.equal(cmd?.scope, "project");
  assert.equal(cmd?.description, "Ship it");
  assert.equal(cmd?.agent, "build");
  assert.match(cmd?.prompt ?? "", /Deploy the app/);
});

test("user-scope commands land in the injected home and can be removed", async () => {
  const { svc, root } = make();
  await svc.saveCommand(root, "user", { name: "greet", prompt: "Say hi" });
  let { commands } = await svc.list(root);
  assert.equal(commands.find((c) => c.name === "greet")?.scope, "user");

  assert.equal(await svc.removeCommand(root, "user", "greet"), true);
  assert.equal(await svc.removeCommand(root, "user", "greet"), false);
  ({ commands } = await svc.list(root));
  assert.equal(commands.some((c) => c.name === "greet"), false);
});

test("saveSnippet round-trips through list() and expand()", async () => {
  const { svc, root } = make();
  await svc.saveSnippet(root, "project", { alias: "sig", text: "— Polyth" });
  const { snippets } = await svc.list(root);
  assert.equal(snippets.find((s) => s.alias === "sig")?.text, "— Polyth");

  const expanded = await svc.expand(root, "bye #sig");
  assert.equal(expanded.text, "bye — Polyth");

  assert.equal(await svc.removeSnippet(root, "project", "sig"), true);
  assert.equal(await svc.removeSnippet(root, "project", "sig"), false);
});

test("names are validated — no path traversal, no empty bodies", async () => {
  const { svc, root } = make();
  await assert.rejects(() => svc.saveCommand(root, "project", { name: "../evil", prompt: "x" }), /letters, digits/);
  await assert.rejects(() => svc.saveSnippet(root, "project", { alias: "a/b", text: "x" }), /letters, digits/);
  await assert.rejects(() => svc.saveCommand(root, "project", { name: "ok", prompt: "  " }), /prompt is required/);
  await assert.rejects(() => svc.saveSnippet(root, "project", { alias: "ok", text: "" }), /text is required/);
  await assert.rejects(() => svc.removeCommand(root, "project", "../../etc"), /letters, digits/);
});
