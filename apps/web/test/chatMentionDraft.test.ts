import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatMentionInsert, collapseChatMentions, expandChatMentions, liveChatMentions,
} from "../src/composer/chatMentionDraft.ts";
import { chatMentionOptions } from "../src/composer/discovery.ts";
import { loadChatMentions, saveChatMentions } from "../src/drafts.ts";
import { loadScopedDraftRecord, recordLocalDraftEdit } from "../src/draftRecord.ts";
import { setClientReliabilityContext, setClientReliabilityProject } from "../src/reliabilityContext.ts";
import { setActiveBrowserAccount } from "../src/accountStorage.ts";

const ID = "4e5ec855-28a1-4e3f-b3a3-28b86aa486e8";
const TOKEN = `[@Tax rounding bug](polyth://session/${ID})`;

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}
function withDraftStorage(run: (storage: MemoryStorage) => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    setClientReliabilityContext({ connectionScope: "chat-mention-draft", spaceId: "default" });
    setClientReliabilityProject("p");
    setActiveBrowserAccount("usr_chat-mention-draft");
    run(storage);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("picking a chat inserts @Title, not the link token", () => {
  const [option] = chatMentionOptions([{ sessionId: ID, title: "Tax rounding bug", updatedAt: 1 } as never], "tax");
  assert.equal(option!.value, "@Tax rounding bug ");
  assert.deepEqual(chatMentionInsert(ID, "Tax [rounding] bug").ref, { label: "Tax rounding bug", sessionId: ID }, "label uses the token's own sanitizing");
});

test("a draft reloaded from storage still sends the link token", () => withDraftStorage(() => {
  recordLocalDraftEdit("s", "Follow up on @Tax rounding bug please");
  saveChatMentions("s", [{ label: "Tax rounding bug", sessionId: ID }]);
  // A reload reads the record back from storage.
  const record = loadScopedDraftRecord("s");
  assert.equal(record.text, "Follow up on @Tax rounding bug please");
  assert.equal(expandChatMentions(record.text, loadChatMentions("s")), `Follow up on ${TOKEN} please`);
}));

test("a draft written before chatMentions existed keeps working", () => withDraftStorage(() => {
  recordLocalDraftEdit("old", `Old ${TOKEN} draft`);
  assert.deepEqual(loadChatMentions("old"), []);
  assert.equal(expandChatMentions(loadScopedDraftRecord("old").text, []), `Old ${TOKEN} draft`);
}));

test("an edited-away label sends plain text and is pruned", () => {
  const refs = [{ label: "Tax rounding bug", sessionId: ID }];
  assert.equal(expandChatMentions("Follow up on @Tax rounding b please", refs), "Follow up on @Tax rounding b please");
  assert.equal(expandChatMentions("see @Tax rounding bugs", refs), "see @Tax rounding bugs", "a longer word is not the label");
  assert.deepEqual(liveChatMentions("Follow up on @Tax rounding b", refs), []);
  assert.deepEqual(liveChatMentions("@Tax rounding bug.", refs), refs);
});

test("each ref takes the first unused occurrence; extra plain mentions stay plain", () => {
  const refs = [{ label: "A", sessionId: "id-1" }];
  assert.equal(expandChatMentions("@A and @A", refs), "[@A](polyth://session/id-1) and @A");
  const two = [{ label: "A", sessionId: "id-1" }, { label: "A", sessionId: "id-2" }];
  assert.equal(expandChatMentions("@A and @A", two), "[@A](polyth://session/id-1) and [@A](polyth://session/id-2)");
  assert.equal(expandChatMentions(`${TOKEN} @A`, refs), `${TOKEN} [@A](polyth://session/id-1)`, "an existing token is left alone");
});

test("recall round-trips: token → @Title + ref → the same token", () => {
  const sent = `Follow up on ${TOKEN} and keep the rate`;
  const shown = collapseChatMentions(sent);
  assert.equal(shown.text, "Follow up on @Tax rounding bug and keep the rate");
  assert.deepEqual(shown.refs, [{ label: "Tax rounding bug", sessionId: ID }]);
  assert.equal(expandChatMentions(shown.text, shown.refs), sent);
});

test("collapse is linear on unterminated openers (CodeQL js/polynomial-redos #155)", () => {
  const started = performance.now();
  assert.equal(collapseChatMentions("[@\\".repeat(50_000)).refs.length, 0);
  assert.equal(collapseChatMentions("[@](polyth://session/!".repeat(10_000)).refs.length, 0);
  assert.ok(performance.now() - started < 1_000);
  const longest = expandChatMentions("@" + "x".repeat(80), [{ label: "x".repeat(80), sessionId: "id-1" }]);
  assert.deepEqual(collapseChatMentions(longest).refs, [{ label: "x".repeat(80), sessionId: "id-1" }]);
});
