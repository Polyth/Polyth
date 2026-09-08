import test from "node:test";
import assert from "node:assert/strict";
import type { ContextBundleDto } from "@polyth/contracts";
import {
  enqueueChatWorkspaceCommand,
  registerChatWorkspaceCommandConsumer,
  resetChatWorkspaceCommands,
  type ChatWorkspacePendingCommand,
} from "../widgets/lib/pendingCommands.ts";

function bundle(sessionId: string, projectId = "proj-a"): ContextBundleDto {
  return {
    id: "bundle-1",
    projectId,
    sessionId,
    presetId: "review",
    label: "Review",
    instruction: "Review",
    sections: [],
    sources: [],
    markdown: "",
    tokens: 0,
    createdAt: Date.now(),
    fingerprints: {},
  };
}

test("cold consumer drains pending commands on register", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({
    kind: "open-drawer",
    presetId: "review",
    presetLabel: "Review changes",
    instruction: "Review",
    presetSourceIds: ["git-diff"],
  }, { projectId: "proj-a", sessionId: "sess-a" });
  const applied: ChatWorkspacePendingCommand["kind"][] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.deepEqual(applied, ["open-drawer"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("hot consumer executes immediately without queueing", () => {
  resetChatWorkspaceCommands();
  const applied: ChatWorkspacePendingCommand["kind"][] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command.kind); },
  });
  enqueueChatWorkspaceCommand({ kind: "notify", message: "hello" }, { projectId: "proj-a", sessionId: "sess-a" });
  enqueueChatWorkspaceCommand({ kind: "set-bundle", bundle: bundle("sess-a") }, { projectId: "proj-a", sessionId: "sess-a" });
  assert.deepEqual(applied, ["notify", "set-bundle"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("commands deliver exactly once", () => {
  resetChatWorkspaceCommands();
  let count = 0;
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: () => { count += 1; },
  });
  enqueueChatWorkspaceCommand({ kind: "notify", message: "once" }, { projectId: "proj-a", sessionId: "sess-a" });
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: () => { count += 1; },
  });
  assert.equal(count, 1);
  registerChatWorkspaceCommandConsumer(null);
});

test("project switch does not consume commands for another project", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({ kind: "notify", message: "keep" }, { projectId: "proj-b", sessionId: "sess-b" });
  const applied: string[] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => {
      if (command.kind === "notify") applied.push(command.message);
    },
  });
  assert.equal(applied.length, 0);
  registerChatWorkspaceCommandConsumer(null);
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-b",
    sessionId: "sess-b",
    apply: (command) => {
      if (command.kind === "notify") applied.push(command.message);
    },
  });
  assert.deepEqual(applied, ["keep"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("session switch does not consume session-scoped commands for another session", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({ kind: "set-bundle", bundle: bundle("sess-a") }, { projectId: "proj-a", sessionId: "sess-a" });
  enqueueChatWorkspaceCommand({
    kind: "open-drawer",
    presetId: "review",
    presetLabel: "Review",
    instruction: "Review",
    presetSourceIds: [],
  }, { projectId: "proj-a", sessionId: "sess-a" });
  const applied: ChatWorkspacePendingCommand["kind"][] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-b",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.equal(applied.length, 0);
  registerChatWorkspaceCommandConsumer(null);
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.deepEqual(applied, ["set-bundle", "open-drawer"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("consumer unmount and remount drains only matching pending commands", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({ kind: "notify", message: "queued" }, { projectId: "proj-a", sessionId: "sess-a" });
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: () => {},
  });
  registerChatWorkspaceCommandConsumer(null);
  enqueueChatWorkspaceCommand({ kind: "copy-bundle" }, { projectId: "proj-a", sessionId: "sess-a" });
  const applied: ChatWorkspacePendingCommand["kind"][] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.deepEqual(applied, ["copy-bundle"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("session-scoped commands with null session do not match active session consumer", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({
    kind: "open-drawer",
    presetId: "review",
    presetLabel: "Review",
    instruction: "Review",
    presetSourceIds: [],
  }, { projectId: "proj-a", sessionId: null });
  const applied: ChatWorkspacePendingCommand["kind"][] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.equal(applied.length, 0);
  registerChatWorkspaceCommandConsumer(null);
});

test("hot copy-bundle with a live bundle is executed, not treated as missing", () => {
  resetChatWorkspaceCommands();
  let prepared: ContextBundleDto | null = bundle("sess-a");
  let copyResult: "copied" | "unavailable" | "none" = "none";
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => {
      if (command.kind !== "copy-bundle") return;
      copyResult = prepared ? "copied" : "unavailable";
    },
  });
  const delivery = enqueueChatWorkspaceCommand({ kind: "copy-bundle" }, { projectId: "proj-a", sessionId: "sess-a" });
  assert.equal(delivery, "executed");
  assert.equal(copyResult, "copied");
  registerChatWorkspaceCommandConsumer(null);
});

test("cold copy-bundle is queued and later copies the originating session bundle", () => {
  resetChatWorkspaceCommands();
  const delivery = enqueueChatWorkspaceCommand({ kind: "copy-bundle" }, { projectId: "proj-a", sessionId: "sess-a" });
  assert.equal(delivery, "queued");
  let copiedSession: string | null = null;
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => {
      if (command.kind === "copy-bundle") copiedSession = "sess-a";
    },
  });
  assert.equal(copiedSession, "sess-a");
  registerChatWorkspaceCommandConsumer(null);
});

test("copy-bundle with no prepared bundle is unavailable at the consumer", () => {
  resetChatWorkspaceCommands();
  const prepared: ContextBundleDto | null = null;
  let copyResult: "copied" | "unavailable" | "none" = "none";
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => {
      if (command.kind !== "copy-bundle") return;
      copyResult = prepared ? "copied" : "unavailable";
    },
  });
  const delivery = enqueueChatWorkspaceCommand({ kind: "copy-bundle" }, { projectId: "proj-a", sessionId: "sess-a" });
  assert.equal(delivery, "executed");
  assert.equal(copyResult, "unavailable");
  registerChatWorkspaceCommandConsumer(null);
});

test("copy-bundle queued in session A does not copy session B", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({ kind: "copy-bundle" }, { projectId: "proj-a", sessionId: "sess-a" });
  const applied: string[] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-b",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.equal(applied.length, 0);
  registerChatWorkspaceCommandConsumer(null);
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.deepEqual(applied, ["copy-bundle"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("paste queued in session A does not open paste in session B", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({ kind: "open-paste" }, { projectId: "proj-a", sessionId: "sess-a" });
  const applied: ChatWorkspacePendingCommand["kind"][] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-b",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.equal(applied.length, 0);
  registerChatWorkspaceCommandConsumer(null);
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command.kind); },
  });
  assert.deepEqual(applied, ["open-paste"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("prepared review bundle and drawer share originating session after switch", () => {
  resetChatWorkspaceCommands();
  const prepared = bundle("sess-a");
  enqueueChatWorkspaceCommand({
    kind: "show-prepared-bundle",
    bundle: prepared,
    presetId: "review",
    presetLabel: "Review changes",
    instruction: "Review",
    presetSourceIds: ["git-diff"],
  }, { projectId: prepared.projectId, sessionId: prepared.sessionId });
  const applied: ChatWorkspacePendingCommand[] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-b",
    apply: (command) => { applied.push(command); },
  });
  assert.equal(applied.length, 0);
  registerChatWorkspaceCommandConsumer(null);
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-a",
    apply: (command) => { applied.push(command); },
  });
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.kind, "show-prepared-bundle");
  if (applied[0]?.kind === "show-prepared-bundle") {
    assert.equal(applied[0].bundle.sessionId, "sess-a");
    assert.equal(applied[0].presetId, "review");
  }
  registerChatWorkspaceCommandConsumer(null);
});

test("notify remains project-scoped across sessions", () => {
  resetChatWorkspaceCommands();
  enqueueChatWorkspaceCommand({ kind: "notify", message: "hello" }, { projectId: "proj-a", sessionId: "sess-a" });
  const applied: string[] = [];
  registerChatWorkspaceCommandConsumer({
    projectId: "proj-a",
    sessionId: "sess-b",
    apply: (command) => {
      if (command.kind === "notify") applied.push(command.message);
    },
  });
  assert.deepEqual(applied, ["hello"]);
  registerChatWorkspaceCommandConsumer(null);
});

test("stale queued commands are bounded so deleted-session bundles cannot accumulate", () => {
  resetChatWorkspaceCommands();
  for (let i = 0; i < 20; i++) {
    enqueueChatWorkspaceCommand({
      kind: "show-prepared-bundle",
      bundle: bundle(`sess-${i}`),
      presetId: "review",
      presetLabel: "Review",
      instruction: "Review",
      presetSourceIds: [],
    }, { projectId: "proj-a", sessionId: `sess-${i}` });
  }
  const applied: string[] = [];
  for (let i = 0; i < 20; i++) {
    registerChatWorkspaceCommandConsumer({
      projectId: "proj-a",
      sessionId: `sess-${i}`,
      apply: (command) => {
        if (command.kind === "show-prepared-bundle") applied.push(command.bundle.sessionId);
      },
    });
    registerChatWorkspaceCommandConsumer(null);
  }
  assert.equal(applied.length, 16);
  assert.equal(applied[0], "sess-4");
  assert.equal(applied.at(-1), "sess-19");
});
