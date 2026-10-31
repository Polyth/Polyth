import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectService, SpaceContext, SpaceRole } from "@polyth/contracts";
import { commandPrecedence } from "../src/catalog.ts";
import { createCommandService, type CommandService } from "../src/index.ts";
import { snippetRoutes } from "../src/serverEntry.ts";
import type { SkillService } from "../src/skills.ts";

const person = (userId: string, role: SpaceRole = "member", spaceId = "spc_a"): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role,
  deployment: "local-trusted",
  storageDir: `/tmp/${spaceId}`,
});

async function make() {
  const home = await mkdtemp(join(tmpdir(), "polyth-cmd-home-"));
  const root = await mkdtemp(join(tmpdir(), "polyth-cmd-root-"));
  const people = await mkdtemp(join(tmpdir(), "polyth-cmd-people-"));
  const svc = createCommandService({
    home,
    personalDir: (userId) => (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(userId) ? join(people, userId) : undefined),
  });
  return { svc, home, root, people };
}

test("personal commands are visible only to their person", async () => {
  const { svc, root } = await make();
  const alice = { space: person("alice") };
  const bob = { space: person("bob") };
  await svc.saveCommand(root, "user", { name: "mine", prompt: "Alice private prompt" }, alice);
  assert.equal((await svc.list(root, alice)).commands.find((c) => c.name === "mine")?.scope, "user");
  assert.equal((await svc.list(root, bob)).commands.some((c) => c.name === "mine"), false);
  await svc.saveSnippet(root, "user", { alias: "sig", text: "Alice sig" }, alice);
  assert.equal((await svc.list(root, bob)).snippets.length, 0);
  assert.equal((await svc.expand(root, "x #sig", { space: person("bob") })).text, "x #sig");
  assert.equal((await svc.expand(root, "/mine", { space: person("alice") })).text.trim(), "Alice private prompt");
  // Bob cannot delete Alice's: his scope resolves to his own (empty) directory.
  assert.equal(await svc.removeCommand(root, "user", "mine", bob), false);
  assert.equal(await svc.removeCommand(root, "user", "mine", alice), true);
});

test("the same person's personal commands follow them across Spaces", async () => {
  const { svc, root } = await make();
  await svc.saveCommand(root, "user", { name: "mine", prompt: "p" }, { space: person("alice", "member", "spc_a") });
  const elsewhere = await svc.list(root, { space: person("alice", "member", "spc_b") });
  assert.ok(elsewhere.commands.some((c) => c.name === "mine"));
});

test("personal commands override Space commands of the same name", async () => {
  const { svc, root } = await make();
  await svc.saveCommand(root, "project", { name: "ship", prompt: "space ship" }, { space: person("dana", "admin") });
  const bob = { space: person("bob") };
  assert.equal((await svc.list(root, bob)).commands.find((c) => c.name === "ship")?.scope, "project");
  await svc.saveCommand(root, "user", { name: "ship", prompt: "my ship" }, bob);
  const listed = await svc.list(root, bob);
  assert.equal(listed.commands.find((c) => c.name === "ship")?.prompt.trim(), "my ship");
  assert.equal((commandPrecedence("ship", listed.commands) as { scope?: string } | undefined)?.scope, "user");
  // Others still get the shared one.
  assert.equal((await svc.list(root, { space: person("carol") })).commands.find((c) => c.name === "ship")?.prompt.trim(), "space ship");
});

test("only Space admins write Space (project) commands and snippets", async () => {
  const { svc, root } = await make();
  const member = { space: person("bob", "member") };
  for (const role of ["viewer", "member"] as const) {
    const ctx = { space: person("bob", role) };
    await assert.rejects(() => svc.saveCommand(root, "project", { name: "x", prompt: "p" }, ctx), (e: Error & { code?: string }) => e.code === "forbidden");
    await assert.rejects(() => svc.removeCommand(root, "project", "x", ctx), (e: Error & { code?: string }) => e.code === "forbidden");
    await assert.rejects(() => svc.saveSnippet(root, "project", { alias: "x", text: "t" }, ctx), (e: Error & { code?: string }) => e.code === "forbidden");
    await assert.rejects(() => svc.removeSnippet(root, "project", "x", ctx), (e: Error & { code?: string }) => e.code === "forbidden");
  }
  await svc.saveCommand(root, "project", { name: "x", prompt: "p" }, { space: person("dana", "admin") });
  await svc.saveSnippet(root, "project", { alias: "x", text: "t" }, { space: person("olga", "owner") });
  assert.equal((await svc.list(root, member)).commands.some((c) => c.name === "x"), true);
  assert.equal(await svc.removeCommand(root, "project", "x", { space: person("dana", "admin") }), true);
});

test("system work reads no personal commands and cannot write them", async () => {
  const { svc, root } = await make();
  await svc.saveCommand(root, "user", { name: "mine", prompt: "private" }, { space: person("alice") });
  for (const ctx of [
    { space: person("system:schedule", "owner") },
    { space: { ...person("alice", "owner"), authority: { kind: "system" } } as SpaceContext },
    {},
  ]) {
    assert.equal((await svc.list(root, ctx)).commands.some((c) => c.name === "mine"), false);
    await assert.rejects(() => svc.saveCommand(root, "user", { name: "n", prompt: "p" }, ctx), (e: Error & { code?: string }) => e.code === "forbidden");
  }
  // A server-supplied acting person opens that person's commands for system-context expansion.
  const expanded = await svc.expand(root, "/mine", { space: person("system:internal", "owner"), actorUserId: "alice" });
  assert.equal(expanded.text.trim(), "private");
});

test("a host without person storage fails closed for writes and lists nothing personal", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-cmd-root-"));
  const svc = createCommandService({ home: await mkdtemp(join(tmpdir(), "h-")), personalDir: () => undefined });
  const ctx = { space: person("alice") };
  await assert.rejects(() => svc.saveCommand(root, "user", { name: "n", prompt: "p" }, ctx), (e: Error & { code?: string }) => e.code === "unavailable");
  assert.equal((await svc.list(root, ctx)).commands.every((c) => c.scope === "builtin"), true);
});

test("legacy home-config commands are copied once to the instance owner; Space owners and others never see them", async () => {
  const { svc, home, root } = await make();
  await mkdir(join(home, ".config", "polyth", "commands"), { recursive: true });
  await mkdir(join(home, ".config", "polyth", "snippets"), { recursive: true });
  await writeFile(join(home, ".config", "polyth", "commands", "old.md"), "legacy prompt\n");
  await writeFile(join(home, ".config", "polyth", "snippets", "oldsig.md"), "legacy sig");
  const canonical = (userId: string, role: SpaceRole, instanceOwner: boolean) =>
    ({ space: { ...person(userId, role), instanceOwner } as SpaceContext });
  assert.equal((await svc.list(root, { space: person("bob", "member") })).commands.some((c) => c.name === "old"), false);
  assert.equal((await svc.list(root, { space: person("dana", "admin") })).commands.some((c) => c.name === "old"), false);
  // Every person owns their own personal Space: Space ownership alone must not adopt the installation's files.
  assert.equal((await svc.list(root, canonical("eve", "owner", false))).commands.some((c) => c.name === "old"), false);
  const owner = await svc.list(root, canonical("olga", "owner", true));
  assert.ok(owner.commands.some((c) => c.name === "old" && c.scope === "user"));
  assert.ok(owner.snippets.some((s) => s.alias === "oldsig"));
  assert.ok(existsSync(join(home, ".config", "polyth", "commands", "old.md")), "home files are copied, never removed");
  // Adopted once: deleting the personal copy does not bring it back.
  assert.equal(await svc.removeCommand(root, "user", "old", canonical("olga", "owner", true)), true);
  assert.equal((await svc.list(root, canonical("olga", "owner", true))).commands.some((c) => c.name === "old"), false);
  assert.equal((await svc.list(root, { space: person("bob", "member") })).commands.some((c) => c.name === "old"), false);
});

test("routes default to personal and refuse Space writes from members with 'forbidden'", async () => {
  const { svc, root } = await make();
  const projects = { get: async (id: string) => (id === "p1" ? { id, path: root } : undefined) } as unknown as ProjectService;
  const skills = { list: async () => [] } as unknown as SkillService;
  const call = async (ctx: SpaceContext, method: string, body: Record<string, unknown>) => {
    let status = 0;
    let payload: unknown;
    const route = snippetRoutes({ projects, commands: svc as CommandService, skills, space: ctx });
    const url = new URL(method === "GET" ? "http://x/api/commands?projectId=p1" : "http://x/api/commands");
    await route({
      path: url.pathname,
      method,
      url,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as never);
    return { status, payload };
  };
  const bob = person("bob");
  assert.equal((await call(bob, "POST", { projectId: "p1", name: "mine", prompt: "p" })).status, 200);
  const mine = ((await call(bob, "GET", {})).payload as Array<{ name: string; scope: string }>).find((c) => c.name === "mine");
  assert.equal(mine?.scope, "user");
  await assert.rejects(
    () => call(bob, "POST", { projectId: "p1", scope: "project", name: "shared", prompt: "p" }),
    (e: Error & { code?: string }) => e.code === "forbidden",
  );
  assert.equal((await call(person("dana", "admin"), "POST", { projectId: "p1", scope: "project", name: "shared", prompt: "p" })).status, 200);
  const carol = (await call(person("carol"), "GET", {})).payload as Array<{ name: string }>;
  assert.equal(carol.some((c) => c.name === "mine"), false);
  assert.equal(carol.some((c) => c.name === "shared"), true);
});
