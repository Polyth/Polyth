import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadLocalMutationIntent,
  submitDirectPromptWithDependencies,
  type DirectPromptDependencies,
} from "../src/mutationIntent.ts";

test("extension slash commands never enter the durable session mutation path", async () => {
  const calls = {
    launch: [] as unknown[],
    retire: [] as Array<[string, string]>,
    send: 0,
  };
  const deps: DirectPromptDependencies = {
    launchExtensionCommand: async (input) => { calls.launch.push(input); },
    projectIdForSession: (sessionId) => sessionId === "s-ext" ? "p-ext" : undefined,
    retireExtensionCommandEcho: (sessionId, text) => { calls.retire.push([sessionId, text]); },
    sendMessage: async () => {
      calls.send += 1;
      throw new Error("session send must not run for extension commands");
    },
  };

  const result = await submitDirectPromptWithDependencies(
    "s-ext",
    {
      text: "/review issue-42",
      command: { id: "extension:com-example-tools:review", args: "issue-42" },
    },
    undefined,
    deps,
  );

  assert.equal(calls.send, 0);
  assert.deepEqual(calls.launch, [{
    commandId: "extension:com-example-tools:review",
    query: "/review issue-42",
    arguments: "issue-42",
    sessionId: "s-ext",
    projectId: "p-ext",
  }]);
  assert.deepEqual(calls.retire, [["s-ext", "/review issue-42"]]);
  assert.equal(typeof result.turnId, "string");
  assert.match(result.turnId ?? "", /^extension:/);
  assert.equal(loadLocalMutationIntent("s-ext"), null);
});

test("extension slash commands reject attachment mixing before launch", async () => {
  let launched = 0;
  let sent = 0;
  const deps: DirectPromptDependencies = {
    launchExtensionCommand: async () => { launched += 1; },
    projectIdForSession: () => "p-ext",
    retireExtensionCommandEcho: () => undefined,
    sendMessage: async () => {
      sent += 1;
      throw new Error("unexpected send");
    },
  };

  await assert.rejects(
    () => submitDirectPromptWithDependencies(
      "s-ext-attachments",
      {
        text: "/review issue-42",
        command: { id: "extension:com-example-tools:review", args: "issue-42" },
        attachments: [{ id: "a", name: "a.txt", mime: "text/plain", size: 1, path: "a.txt" }],
      },
      undefined,
      deps,
    ),
    (error: Error & { code?: string; status?: number }) =>
      error.code === "invalid-input" && error.status === 409,
  );
  assert.equal(launched, 0);
  assert.equal(sent, 0);
  assert.equal(loadLocalMutationIntent("s-ext-attachments"), null);
});
