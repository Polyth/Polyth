import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRIBUTION_MAX_RESOURCES,
  parseContributionCompletion,
  parseContributionResult,
} from "../src/contributions.ts";

test("contribution results preserve bounded structured resources, context, and Remote UI", () => {
  const parsed = parseContributionCompletion({
    invocationId: "invoke-1",
    lease: "lease-token",
    ok: true,
    result: {
      resources: [{
        provider: "tasks",
        resourceId: "TASK-42",
        title: "Ship release",
        url: "https://tasks.example/items/42",
        summary: "Release task",
        metadata: { priority: 2, labels: ["release", "ops"] },
        provenance: {
          source: "task-provider",
          uri: "https://tasks.example/items/42",
          retrievedAt: 123,
        },
      }],
      context: [{
        provider: "tasks",
        sourceId: "TASK-42",
        title: "Ship release",
        retrievedAt: 123,
        summary: "Release task",
        content: "Prepare and ship the release.",
      }],
      ui: {
        type: "stack",
        children: [
          { type: "heading", text: "Task", level: 2 },
          { type: "button", label: "Attach", action: "attach" },
        ],
      },
      status: { label: "Ready", tone: "success" },
    },
  });

  assert.equal(parsed.result?.resources?.[0]?.resourceId, "TASK-42");
  assert.deepEqual(parsed.result?.resources?.[0]?.metadata, { priority: 2, labels: ["release", "ops"] });
  assert.equal(parsed.result?.context?.[0]?.content, "Prepare and ship the release.");
  assert.equal(parsed.result?.ui?.children?.[1]?.action, "attach");
});

test("contribution completion rejects replay-shaping and unsafe external data", () => {
  assert.throws(() => parseContributionCompletion({
    invocationId: "invoke-1",
    lease: "lease-token",
    ok: false,
  }), /must include an error/);

  assert.throws(() => parseContributionCompletion({
    invocationId: "invoke-1",
    lease: "lease-token",
    ok: true,
    error: { message: "ambiguous" },
  }), /must not include an error/);

  assert.throws(() => parseContributionResult({
    resources: [{
      provider: "tasks",
      resourceId: "TASK-42",
      title: "Task",
      url: "http://insecure.example/item",
    }],
  }), /https URL/);

  assert.throws(() => parseContributionResult({
    resources: [{
      provider: "tasks",
      resourceId: "TASK-42",
      title: "Task",
      url: "https://user:secret@example.com/item",
    }],
  }), /without credentials/);

  assert.throws(() => parseContributionResult({
    status: { label: "Ready", tone: "mystery" },
  }), /tone is invalid/);
});

test("contribution metadata rejects dangerous keys, excessive depth, and item floods", () => {
  const unsafe = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
  assert.throws(() => parseContributionResult({
    resources: [{
      provider: "tasks",
      resourceId: "TASK-42",
      title: "Task",
      metadata: unsafe,
    }],
  }), /unsafe key/);

  let deep: Record<string, unknown> = { value: "leaf" };
  for (let index = 0; index < 20; index += 1) deep = { child: deep };
  assert.throws(() => parseContributionResult({
    context: [{
      provider: "tasks",
      sourceId: "task-1",
      title: "Task",
      content: "context",
      metadata: deep,
    }],
  }), /depth limit/);

  assert.throws(() => parseContributionResult({
    resources: [{
      provider: "tasks",
      resourceId: "TASK-42",
      title: "Task",
      metadata: { rows: Array.from({ length: 129 }, (_, index) => index) },
    }],
  }), /array is too large/);

  assert.throws(() => parseContributionResult({
    resources: [{
      provider: "tasks",
      resourceId: "TASK-42",
      title: "Task",
      metadata: { value: Number.POSITIVE_INFINITY },
    }],
  }), /non-finite number/);
});

test("contribution results enforce list and Remote UI limits", () => {
  assert.throws(() => parseContributionResult({
    resources: Array.from({ length: CONTRIBUTION_MAX_RESOURCES + 1 }, (_, index) => ({
      provider: "tasks",
      resourceId: `task-${index}`,
      title: `Task ${index}`,
    })),
  }), /too many resources/);

  assert.throws(() => parseContributionResult({
    ui: {
      type: "stack",
      children: [{ type: "rawHtml", body: "<script>bad()</script>" }],
    },
  }), /child node is invalid/);

  assert.throws(() => parseContributionResult({
    context: [{
      provider: "tasks",
      sourceId: "task-1",
      title: "Task",
      retrievedAt: 1,
      summary: "",
      content: "x".repeat(24_001),
    }],
  }), /context content is invalid/);
});
