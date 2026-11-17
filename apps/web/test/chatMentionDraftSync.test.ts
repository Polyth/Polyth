import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptServerDraft, loadScopedDraftRecord, recordLocalDraftEdit, updateScopedDraftRecord } from "../src/draftRecord.ts";
import { saveDraftToServerNow } from "../src/utils.ts";
import { loadChatMentions, saveChatMentions } from "../src/drafts.ts";
import { expandChatMentions } from "../src/composer/chatMentionDraft.ts";
import { sessionDraftLine } from "../src/sessionDraft.ts";
import { setClientReliabilityContext, setClientReliabilityProject } from "../src/reliabilityContext.ts";
import { setActiveBrowserAccount } from "../src/accountStorage.ts";

const { api } = await import("@polyth/session/web-api");
const ID = "4e5ec855-28a1-4e3f-b3a3-28b86aa486e8";
const TOKEN = `[@Tax bug](polyth://session/${ID})`;
const REF = { label: "Tax bug", sessionId: ID };

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}
async function withDevice(name: string, run: () => Promise<void> | void): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
  try {
    setClientReliabilityContext({ connectionScope: name, spaceId: "default" });
    setClientReliabilityProject("p");
    setActiveBrowserAccount(`usr_${name}`);
    await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("device A sends token text, device B shows @Title and keeps the ref for its send", async () => {
  let wire = "";
  const original = api.saveDraft;
  api.saveDraft = (async (_id: string, text: string) => { wire = text; return { draftUpdatedAt: 7 }; }) as typeof api.saveDraft;
  try {
    await withDevice("sync-a", async () => {
      adoptServerDraft("s", "", 1);
      recordLocalDraftEdit("s", "see @Tax bug now");
      saveChatMentions("s", [REF]);
      assert.equal(await saveDraftToServerNow("s"), true);
      assert.equal(wire, `see ${TOKEN} now`);
      const record = loadScopedDraftRecord("s");
      assert.equal(record.text, "see @Tax bug now");
      assert.ok(!record.dirty);
    });
  } finally { api.saveDraft = original; }
  await withDevice("sync-b", () => {
    const record = adoptServerDraft("s", wire, 7);
    assert.equal(record.text, "see @Tax bug now");
    assert.deepEqual(loadChatMentions("s"), [REF]);
    assert.ok(!record.dirty);
    assert.equal(expandChatMentions(record.text, loadChatMentions("s")), wire);
  });
});

test("an unedited round trip is neither a conflict nor dirty", () => withDevice("sync-rt", () => {
  adoptServerDraft("s", `see ${TOKEN}`, 3);
  assert.equal(loadScopedDraftRecord("s").text, "see @Tax bug");
  // The same projection again, clean.
  const again = adoptServerDraft("s", `see ${TOKEN}`, 3);
  assert.equal(again.conflict, undefined);
  assert.ok(!again.dirty);
  // Dirty local draft: the echo of our own wire text only acknowledges it.
  recordLocalDraftEdit("s", "see @Tax bug");
  const acked = adoptServerDraft("s", `see ${TOKEN}`, 3);
  assert.equal(acked.conflict, undefined);
  assert.ok(!acked.dirty);
}));

test("a different remote draft conflicts in display form with its refs", () => withDevice("sync-conflict", () => {
  adoptServerDraft("s", "", 1);
  recordLocalDraftEdit("s", "mine");
  const result = adoptServerDraft("s", `other ${TOKEN}`, 2);
  assert.equal(result.text, "mine");
  assert.deepEqual(result.conflict, { text: "other @Tax bug", serverUpdatedAt: 2, chatMentions: [REF] });
}));

test("a label edited away sends plain text, a draft without mentions is unchanged", async () => {
  const sent: string[] = [];
  const original = api.saveDraft;
  api.saveDraft = (async (_id: string, text: string) => { sent.push(text); return { draftUpdatedAt: 9 }; }) as typeof api.saveDraft;
  try {
    await withDevice("sync-plain", async () => {
      adoptServerDraft("s", "", 1);
      recordLocalDraftEdit("s", "edited label");
      saveChatMentions("s", [REF]);
      await saveDraftToServerNow("s");
      recordLocalDraftEdit("s", "just text <b>&</b> \\n");
      updateScopedDraftRecord("s", { chatMentions: undefined });
      await saveDraftToServerNow("s");
    });
  } finally { api.saveDraft = original; }
  assert.deepEqual(sent, ["edited label", "just text <b>&</b> \\n"]);
});

test("the navigator preview shows @Title", () => {
  const line = sessionDraftLine({ summary: false, draft: `see ${TOKEN}`, draftPreview: undefined, lastTurnAt: null } as never);
  assert.equal(line, "see @Tax bug");
});
