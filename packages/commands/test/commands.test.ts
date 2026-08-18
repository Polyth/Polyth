import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommandService, parseFrontmatter } from "../src/index.ts";

async function withDirs(fn: (root: string, home: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "polyth-cmd-root-"));
  const home = await mkdtemp(path.join(tmpdir(), "polyth-cmd-home-"));
  try {
    await fn(root, home);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

test("parseFrontmatter reads yaml-ish keys and body", () => {
  const parsed = parseFrontmatter(
    "---\ndescription: Do the thing\nagent: build\nmodel: gpt-test\n---\nHello $ARGUMENTS\n",
  );
  assert.equal(parsed.description, "Do the thing");
  assert.equal(parsed.agent, "build");
  assert.equal(parsed.model, "gpt-test");
  assert.equal(parsed.body, "Hello $ARGUMENTS\n");
});

test("project commands override user by name; builtins present", async () => {
  await withDirs(async (root, home) => {
    await mkdir(path.join(home, ".config", "polyth", "commands"), { recursive: true });
    await mkdir(path.join(root, ".polyth", "commands"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "polyth", "commands", "greet.md"),
      "---\ndescription: user greet\n---\nuser prompt\n",
    );
    await writeFile(
      path.join(root, ".polyth", "commands", "greet.md"),
      "---\ndescription: project greet\nagent: build\n---\nproject prompt\n",
    );
    await writeFile(
      path.join(home, ".config", "polyth", "commands", "review.md"),
      "---\ndescription: user review override\n---\nuser review body\n",
    );
    const svc = createCommandService({ home });
    const { commands } = await svc.list(root);
    const greet = commands.find((c) => c.name === "greet");
    assert.ok(greet);
    assert.equal(greet!.scope, "project");
    assert.equal(greet!.description, "project greet");
    assert.equal(greet!.agent, "build");
    const review = commands.find((c) => c.name === "review");
    assert.equal(review!.scope, "user");
    assert.equal(review!.description, "user review override");
    const init = commands.find((c) => c.name === "init");
    assert.equal(init!.scope, "builtin");
    const compact = commands.find((c) => c.name === "compact");
    const summary = commands.find((c) => c.name === "summary");
    assert.ok(compact && summary);
  });
});

test("$ARGUMENTS substitution and append when missing", async () => {
  await withDirs(async (root, home) => {
    await mkdir(path.join(root, ".polyth", "commands"), { recursive: true });
    await writeFile(
      path.join(root, ".polyth", "commands", "withargs.md"),
      "---\ndescription: args\n---\nUse $ARGUMENTS please\n",
    );
    await writeFile(
      path.join(root, ".polyth", "commands", "noargs.md"),
      "---\ndescription: noargs\n---\nJust this.\n",
    );
    const svc = createCommandService({ home });
    const a = await svc.expand(root, "/withargs foo bar");
    assert.equal(a.usedCommand, "withargs");
    assert.match(a.text, /Use foo bar please/);
    assert.equal(a.raw, "/withargs foo bar");
    const b = await svc.expand(root, "/noargs extra bits");
    assert.equal(b.usedCommand, "noargs");
    assert.match(b.text, /Just this\.\n\nextra bits/);
  });
});

test("unknown command is left untouched", async () => {
  await withDirs(async (root, home) => {
    const svc = createCommandService({ home });
    const got = await svc.expand(root, "/nope hello");
    assert.equal(got.text, "/nope hello");
    assert.equal(got.usedCommand, undefined);
  });
});

test("@file inclusion, missing left as-is", async () => {
  await withDirs(async (root, home) => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "export const x = 1;\n");
    const svc = createCommandService({ home });
    const got = await svc.expand(root, "see @src/a.ts and @missing.ts");
    assert.match(got.text, /```src\/a\.ts\nexport const x = 1;\n```/);
    assert.match(got.text, /@missing\.ts/);
  });
});

test("!shell substitution and first-line shell mode", async () => {
  await withDirs(async (root, home) => {
    await writeFile(path.join(root, "n.txt"), "ok");
    const svc = createCommandService({ home });
    const line = await svc.expand(root, "before\n!echo hello-shell\nafter");
    assert.match(line.text, /before/);
    assert.match(line.text, /hello-shell/);
    assert.match(line.text, /after/);
    const mode = await svc.expand(root, "!cat n.txt");
    assert.match(mode.text, /```/);
    assert.match(mode.text, /ok/);
  });
});

test("#snippet expansion; unknown alias untouched", async () => {
  await withDirs(async (root, home) => {
    await mkdir(path.join(home, ".config", "polyth", "snippets"), { recursive: true });
    await mkdir(path.join(root, ".polyth", "snippets"), { recursive: true });
    await writeFile(path.join(home, ".config", "polyth", "snippets", "sig.md"), "Best regards");
    await writeFile(path.join(root, ".polyth", "snippets", "sig.md"), "Project regards");
    const svc = createCommandService({ home });
    const { snippets } = await svc.list(root);
    const sig = snippets.find((s) => s.alias === "sig");
    assert.equal(sig!.scope, "project");
    const got = await svc.expand(root, "Hi #sig and #unknown");
    assert.match(got.text, /Hi Project regards and #unknown/);
  });
});
