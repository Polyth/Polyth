import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { ContextBundleDto } from "@polyth/contracts";
import type { ApiTransport, WebPackageHost } from "@polyth/web-sdk";
import type { CopyContextResult } from "../widgets/lib/pendingCommands.ts";

register("./tsxHooks.mjs", import.meta.url);

const { createChatWorkspaceCommands } = await import("../widgets/lib/commands.ts");

function bundle(sessionId: string, projectId = "proj-a"): ContextBundleDto {
  return {
    id: "bundle-1",
    projectId,
    sessionId,
    presetId: "review",
    label: "Review changes",
    instruction: "Review",
    sections: [],
    sources: [],
    markdown: "",
    tokens: 0,
    createdAt: Date.now(),
    fingerprints: {},
  };
}

function mockHost(): WebPackageHost {
  return {
    navigation: { openWorkspacePane() {} },
  } as unknown as WebPackageHost;
}

test("copy context does not report missing bundle when delivery is executed", async () => {
  let noBundle = 0;
  const commands = createChatWorkspaceCommands({
    host: mockHost(),
    transport: {} as ApiTransport,
    getProjectId: () => "proj-a",
    getSessionId: () => "sess-a",
    copyBundle: () => "executed",
    onNoBundle: () => { noBundle += 1; },
  });
  await commands.copyContext();
  assert.equal(noBundle, 0);
});

test("copy context does not report missing bundle when delivery is queued", async () => {
  let noBundle = 0;
  const commands = createChatWorkspaceCommands({
    host: mockHost(),
    transport: {} as ApiTransport,
    getProjectId: () => "proj-a",
    getSessionId: () => "sess-a",
    copyBundle: () => "queued" satisfies CopyContextResult,
    onNoBundle: () => { noBundle += 1; },
  });
  await commands.copyContext();
  assert.equal(noBundle, 0);
});

test("copy context reports missing bundle only when unavailable", async () => {
  let noBundle = 0;
  const commands = createChatWorkspaceCommands({
    host: mockHost(),
    transport: {} as ApiTransport,
    getProjectId: () => "proj-a",
    getSessionId: () => "sess-a",
    copyBundle: () => "unavailable",
    onNoBundle: () => { noBundle += 1; },
  });
  await commands.copyContext();
  assert.equal(noBundle, 1);
});

test("review preparation keeps originating session after host session switches", async () => {
  let sessionId = "sess-a";
  const captured: Array<{ bundle: ContextBundleDto; drawer: { presetId: string } }> = [];
  const commands = createChatWorkspaceCommands({
    host: mockHost(),
    transport: {
      async post() {
        return bundle("sess-a");
      },
    } as unknown as ApiTransport,
    getProjectId: () => "proj-a",
    getSessionId: () => sessionId,
    copyBundle: () => "queued",
    onPreparedBundle: (input) => {
      sessionId = "sess-b";
      captured.push(input);
    },
  });
  const create = commands.openPreset("review");
  sessionId = "sess-b";
  await create;
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.bundle.sessionId, "sess-a");
  assert.equal(captured[0]?.drawer.presetId, "review");
});
