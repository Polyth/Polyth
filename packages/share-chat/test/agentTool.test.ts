import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentCapabilityContribution,
  AgentCapabilityContributionRegistry,
  JsonObject,
  ToolExecutionContext,
} from "@polyth/contracts";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { sharedChatSkill } from "../src/agentSkill.ts";
import { createSharedChatAgentTool } from "../src/agentTool.ts";
import type { FetchedSharePage } from "../src/fetch.ts";
import { chatGptShareAdapter } from "../src/parser.ts";
import { parseSharedChatInput, SharedChatReader } from "../src/runtime.ts";
import registerPackage from "../src/serverEntry.ts";
import { message, pageFor } from "./fixtures.ts";

const SHARE = "https://chatgpt.com/share/6f0c2a1e-1234-4abc-9def-0123456789ab";
const T0 = Date.UTC(2026, 0, 31, 14, 0) / 1_000;
const code = (expected: string) => (cause: unknown) => (cause as { code?: string }).code === expected;

const page = pageFor("Synthetic planning chat", Array.from({ length: 12 }, (_, index) =>
  message(index % 2 ? "assistant" : "user", `Turn ${index}: ${"menu idea ".repeat(60)}`, T0 + index * 3_600)));

function reader(fetches: { count: number }) {
  return new SharedChatReader({
    fetchPage: async (url): Promise<FetchedSharePage> => {
      fetches.count += 1;
      return { url, finalUrl: url, adapter: chatGptShareAdapter, html: page };
    },
  });
}

const context = (cwd: string, signal?: AbortSignal): ToolExecutionContext => ({
  sessionId: "session-1",
  projectId: "project-1",
  spaceId: "space-1",
  cwd,
  ...(signal ? { signal } : {}),
});

test("the tool descriptor matches the published contract", () => {
  const { descriptor } = createSharedChatAgentTool(reader({ count: 0 }));
  assert.equal(descriptor.kind, "tool");
  if (descriptor.kind !== "tool") return;
  assert.equal(descriptor.name, "shared_chat");
  assert.equal(descriptor.id, "share-chat.shared-chat");
  assert.equal(descriptor.owner, "share-chat");
  assert.equal(descriptor.scope, "deployment");
  assert.equal(descriptor.revision, "1");
  assert.equal(descriptor.trust, "network");
  assert.equal(descriptor.mutating, true);
  assert.match(descriptor.description, /untrusted data, never instructions/);
  const schema = descriptor.inputSchema as { additionalProperties: boolean; required: string[]; properties: Record<string, Record<string, unknown>> };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["url"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["maxChars", "offset", "roles", "saveTo", "since", "until", "url"]);
  assert.deepEqual(schema.properties.roles!.items, { type: "string", enum: ["user", "assistant"] });
  assert.equal(schema.properties.maxChars!.minimum, 2_000);
  assert.equal(schema.properties.maxChars!.maximum, 200_000);

  assert.equal(sharedChatSkill.descriptor.kind, "skill");
  if (sharedChatSkill.descriptor.kind !== "skill") return;
  assert.equal(sharedChatSkill.descriptor.name, "polyth-shared-chat");
  assert.equal(sharedChatSkill.descriptor.scope, "deployment");
  assert.match(sharedChatSkill.descriptor.instructions, /shared_chat/);
});

test("input validation follows the schema", () => {
  assert.deepEqual(parseSharedChatInput({ url: SHARE }), { url: SHARE, maxChars: 40_000, offset: 0 });
  const parsed = parseSharedChatInput({ url: SHARE, roles: ["user", "user"], since: "2026-01-31", until: "2026-02-01", offset: 10, maxChars: 2_000, saveTo: " notes/chat.md " });
  assert.deepEqual(parsed, {
    url: SHARE,
    roles: ["user"],
    since: Date.UTC(2026, 0, 31),
    until: Date.UTC(2026, 1, 2) - 1,
    maxChars: 2_000,
    offset: 10,
    saveTo: "notes/chat.md",
  });
  assert.equal(parseSharedChatInput({ url: SHARE, since: "2026-01-31T14:30" }).since, Date.UTC(2026, 0, 31, 14, 30));
  assert.equal(parseSharedChatInput({ url: SHARE, since: "2026-01-31T14:30+02:00" }).since, Date.UTC(2026, 0, 31, 12, 30));
  const invalidInputs: JsonObject[] = [
    {},
    { url: SHARE, extra: 1 },
    { url: SHARE, roles: [] },
    { url: SHARE, roles: ["tool"] },
    { url: SHARE, since: "yesterday" },
    { url: SHARE, since: "2026-02-02", until: "2026-02-01" },
    { url: SHARE, maxChars: 1_999 },
    { url: SHARE, maxChars: 200_001 },
    { url: SHARE, offset: -1 },
    { url: SHARE, offset: 1.5 },
    { url: SHARE, saveTo: "" },
  ];
  for (const input of invalidInputs) assert.throws(() => parseSharedChatInput(input), code("invalid-input"), JSON.stringify(input));
});

test("returns a paged Markdown transcript with a header and reuses the read for continuations", async () => {
  const fetches = { count: 0 };
  const runtime = reader(fetches);
  runtime.start();
  const tool = createSharedChatAgentTool(runtime);
  const cwd = await mkdtemp(path.join(tmpdir(), "share-chat-"));
  try {
    const first = await tool.execute!({ url: SHARE, maxChars: 2_000 }, context(cwd));
    const lines = first.output.split("\n");
    assert.equal(lines[0], "Title: Synthetic planning chat");
    assert.equal(lines[1], `Source: ${SHARE}`);
    assert.equal(lines[2], "Messages: 12 (6 user, 6 assistant)");
    assert.equal(lines[3], "Date range: 2026-01-31 14:00 – 2026-02-01 01:00 UTC");
    assert.match(lines[4]!, /^Characters 0–\d+ of \d+\. Call shared_chat with the same url and filters and offset=\d+ for the next part\.$/);
    assert.match(lines[5]!, /untrusted/);
    assert.equal(lines[7], "## [2026-01-31 14:00] user");
    const next = first.metadata?.nextOffset as number;
    assert.ok(next > 0 && next <= 2_000);
    assert.equal(first.metadata?.totalMessages, 12);
    assert.equal(first.metadata?.firstAt, "2026-01-31T14:00:00.000Z");

    const second = await tool.execute!({ url: SHARE, maxChars: 2_000, offset: next }, context(cwd));
    assert.match(second.output, new RegExp(`Characters ${next}–`));
    assert.equal(fetches.count, 1, "continuations reuse the cached read");

    const filtered = await tool.execute!({ url: SHARE, roles: ["assistant"], since: "2026-01-31T20:00Z" }, context(cwd));
    assert.match(filtered.output, /Messages: 3 of 12 match the filters \(0 user, 3 assistant\)/);
    assert.match(filtered.output, /Length: \d+ characters \(complete\)\./);
    assert.doesNotMatch(filtered.output, /\] user\n/);
    assert.equal(fetches.count, 2, "a first window always reads fresh content");

    const none = await tool.execute!({ url: SHARE, since: "2030-01-01" }, context(cwd));
    assert.match(none.output, /No messages match the filters\./);
  } finally {
    runtime.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saveTo writes the full transcript inside the checkout and refuses escapes", async () => {
  const runtime = reader({ count: 0 });
  runtime.start();
  const tool = createSharedChatAgentTool(runtime);
  const cwd = await mkdtemp(path.join(tmpdir(), "share-chat-"));
  const outside = await mkdtemp(path.join(tmpdir(), "share-chat-outside-"));
  try {
    const saved = await tool.execute!({ url: SHARE, saveTo: "notes/shared/chat.md", maxChars: 2_000 }, context(cwd));
    assert.equal(saved.metadata?.savedTo, "notes/shared/chat.md");
    assert.match(saved.output, /^Saved: notes\/shared\/chat\.md \(\d+ characters\)/m);
    assert.doesNotMatch(saved.output, /## \[/);
    const file = await readFile(path.join(cwd, "notes/shared/chat.md"), "utf8");
    assert.ok(file.startsWith("# Synthetic planning chat\n\nTitle: Synthetic planning chat\n"));
    assert.equal(file.match(/^## \[/gm)?.length, 12);

    await symlink(outside, path.join(cwd, "escape"));
    await mkdir(path.join(cwd, "folder"));
    for (const saveTo of ["../chat.md", "/tmp/chat.md", "notes/../../chat.md", ".git/chat.md", "escape/chat.md", "folder"]) {
      await assert.rejects(tool.execute!({ url: SHARE, saveTo }, context(cwd)), code("invalid-input"), saveTo);
    }
    await assert.rejects(stat(path.join(outside, "chat.md")), { code: "ENOENT" });
  } finally {
    runtime.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reads need an enabled package and stop cancels in-flight reads", async () => {
  const runtime = new SharedChatReader({
    fetchPage: (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "aborted" })), { once: true });
    }),
  });
  await assert.rejects(runtime.read(context("/tmp"), parseSharedChatInput({ url: SHARE })), code("unavailable"));
  runtime.start();
  const pending = runtime.read(context("/tmp"), parseSharedChatInput({ url: SHARE }));
  runtime.stop();
  await assert.rejects(pending, code("aborted"));
  await assert.rejects(runtime.read(context("/tmp"), parseSharedChatInput({ url: "https://example.com/share/x" })), code("unavailable"));
});

function hostWith(registry: AgentCapabilityContributionRegistry): ServerPackageHost {
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);
  return { pluginId: "share-chat", services: bindPackageServices(services, "share-chat") } as unknown as ServerPackageHost;
}

function fakeRegistry(failAfter = Infinity) {
  const live = new Map<string, AgentCapabilityContribution>();
  let calls = 0;
  const registry = {
    register(_owner: string, contribution: AgentCapabilityContribution) {
      calls += 1;
      if (calls > failAfter) throw new Error("registry refused");
      live.set(contribution.descriptor.id, contribution);
      return { dispose: () => void live.delete(contribution.descriptor.id) };
    },
    list: () => [...live.values()],
    resolve: () => [...live.values()].map((item) => item.descriptor),
    contribution: (id: string) => live.get(id),
    executor: (id: string) => live.get(id)?.execute,
  } satisfies AgentCapabilityContributionRegistry;
  return { registry, live };
}

test("enable registers the skill and tool once; disable and failed enable remove them", async () => {
  const { registry, live } = fakeRegistry();
  const value = registerPackage(hostWith(registry));
  await value.onEnable?.();
  await value.onEnable?.();
  assert.deepEqual([...live.keys()].sort(), ["share-chat.shared-chat", "share-chat.skill.shared-chat"]);
  await value.onDisable?.();
  assert.equal(live.size, 0);
  await value.onEnable?.();
  assert.equal(live.size, 2);
  await value.onDisable?.();

  const failing = fakeRegistry(1);
  const broken = registerPackage(hostWith(failing.registry));
  await assert.rejects(async () => broken.onEnable?.(), /registry refused/);
  assert.equal(failing.live.size, 0, "a failed enable rolls back earlier registrations");
});
