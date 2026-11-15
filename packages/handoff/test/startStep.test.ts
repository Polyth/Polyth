import test from "node:test";
import assert from "node:assert/strict";
import type { HandoffResultImportedData, JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { handoffImportStep } from "../src/serverEntry.ts";

const provenance: HandoffResultImportedData["provenance"] = {
  sourceKind: "chat-workspace",
  provider: "opencode",
  profileName: "default",
};

function fixture() {
  const appended: SessionEvent[] = [];
  const host = {
    store: { events: async () => appended },
    events: {
      append: async (sessionId: string, type: string, data: JsonObject) => {
        const event = {
          id: `e${appended.length + 1}`,
          sessionId,
          seq: appended.length + 1,
          time: appended.length + 1,
          type,
          data,
        } as SessionEvent;
        appended.push(event);
        return event;
      },
    },
  } as unknown as ServerPackageHost;
  const session = { id: "s1" } as SessionProjection;
  return { appended, step: handoffImportStep(host), session };
}

test("the handoff.import start step records the import for the started session", async () => {
  const { appended, step, session } = fixture();
  await step.run({ provenance, textHash: "abc" }, { projectId: "p1", session });
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.type, "handoff/result-imported");
  assert.equal(appended[0]!.sessionId, "s1");
  assert.deepEqual(appended[0]!.data.provenance, provenance);
  assert.equal(appended[0]!.data.textHash, "abc");
});

test("a repeated identical import appends nothing", async () => {
  const { appended, step, session } = fixture();
  await step.run({ provenance, textHash: "abc" }, { projectId: "p1", session });
  await step.run({ provenance, textHash: "abc" }, { projectId: "p1", session });
  assert.equal(appended.length, 1);
});

test("a malformed payload is rejected by validate", () => {
  const { step } = fixture();
  for (const payload of [{}, { provenance }, { textHash: "abc" }, { provenance, textHash: "" }]) {
    assert.throws(
      () => step.validate!(payload as JsonObject, { projectId: "p1" }),
      (error: Error & { code?: string }) => error.code === "invalid-input",
    );
  }
});
