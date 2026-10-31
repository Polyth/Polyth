import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectService, SpaceContext } from "@polyth/contracts";
import { snippetRoutes, withSkillInvocations } from "../src/serverEntry.ts";
import type { CommandService } from "../src/index.ts";
import type { SkillService } from "../src/skills.ts";
import { parseExtensionCommandId, type SlashCommand } from "../src/catalog.ts";

const project = { id: "p1", path: "/tmp/project" };
const projects = {
  get: async (id: string) => id === "p1" ? project : undefined,
} as unknown as ProjectService;

const commands = {
  list: async () => ({
    commands: [{
      name: "builtin",
      description: "built in",
      prompt: "x",
      scope: "builtin",
      owner: "builtin",
    }],
    snippets: [{ alias: "sig", text: "Regards", scope: "project" }],
  }),
} as unknown as CommandService;

const skills = {
  list: async () => [{
    name: "repo-check",
    description: "Use repository checks",
    instructions: "Run repository checks.",
    scope: "project",
  }],
} as unknown as SkillService;
const space = { spaceId: "space-a" } as SpaceContext;
const extension: SlashCommand = {
  id: "extension:com-example:review",
  name: "review",
  description: "Review through extension",
  prompt: "",
  scope: "builtin",
  owner: "builtin",
};

async function get(path: "/api/commands" | "/api/snippets", extensionCommands: () => Promise<SlashCommand[]>) {
  let status = 0;
  let payload: unknown;
  const handler = snippetRoutes({ projects, commands, skills, space, extensionCommands });
  const handled = await handler({
    path,
    method: "GET",
    url: new URL(`http://polyth.test${path}?projectId=p1`),
    body: async () => ({}),
    json: (nextStatus: number, nextPayload: unknown) => {
      status = nextStatus;
      payload = nextPayload;
    },
  } as never);
  return { handled, status, payload };
}

test("command discovery appends Space-scoped extension descriptors without widening the legacy DTO", async () => {
  let calls = 0;
  const response = await get("/api/commands", async () => {
    calls += 1;
    return [extension];
  });
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const items = response.payload as SlashCommand[];
  assert.deepEqual(items.map((item) => [item.name, item.owner]), [
    ["builtin", "builtin"],
    ["review", "builtin"],
    ["repo-check", "builtin"],
  ]);
  assert.deepEqual(parseExtensionCommandId(items[1]?.id ?? ""), {
    packageId: "com-example",
    contributionId: "review",
  });
});

test("snippet discovery never leaks extension command descriptors", async () => {
  let calls = 0;
  const response = await get("/api/snippets", async () => {
    calls += 1;
    return [extension];
  });
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
  assert.deepEqual(response.payload, [{ alias: "sig", text: "Regards", scope: "project" }]);
});


test("portable skill discovery never shadows an extension command", async () => {
  const response = await get("/api/commands", async () => [{
    ...extension,
    name: "repo-check",
  }]);
  const items = response.payload as SlashCommand[];
  assert.equal(items.filter((item) => item.name === "repo-check").length, 1);
  assert.equal(items.find((item) => item.name === "repo-check")?.id?.startsWith("extension:"), true);
});

test("portable skill invocation renders effective instructions exactly once", async () => {
  const base = {
    async expand(_root: string, text: string) {
      return { text, raw: text };
    },
  } as unknown as CommandService;
  const wrapped = withSkillInvocations(base, skills);
  const result = await wrapped.expand("/tmp/project", "/repo-check inspect src", {
    space,
    projectId: "p1",
  });
  assert.equal(result.usedCommand, "repo-check");
  assert.match(result.text, /Run repository checks\./);
  assert.match(result.text, /Request:\ninspect src/);
});
