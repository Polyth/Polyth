// Composer people mode: one @ picker with People first, mode/label decisions,
// and the carry toggle's collaborate gate. Pure (localStorage shimmed).
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionMentionCandidateDto } from "@polyth/contracts";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  groupAutocompleteOptions, mentionAndFileAutocomplete, peopleAutocomplete, autocompleteOptionId,
} = await import("../src/composer/discovery.ts");
const {
  livePersonMentions, peopleModeActive, peopleSendLabel, showCarryToAgent,
} = await import("../src/composer/people.ts");
const { personMentionToken } = await import("../src/sessionPeople.ts");
const { tr } = await import("../src/i18n/index.ts");

const people: SessionMentionCandidateDto[] = [
  { userId: "u-alice", name: "Alice", access: "collaborate" },
  { userId: "u-bob", name: "Bob", access: "view" },
];

test("@ picker lists the People group before Files and filters by query", () => {
  const both = mentionAndFileAutocomplete(
    [...people, { userId: "u-src", name: "Ssrc", access: "view" }],
    "s",
    "done",
    [{ path: "src/app.ts", kind: "file" }],
  );
  assert.deepEqual(both.options.map((option) => option.presentation?.groupId), ["people", "files"]);
  const groups = groupAutocompleteOptions(both.options);
  assert.deepEqual(groups.map((group) => group.id), ["people", "files"]);
  assert.equal(groups[0]?.label, tr("composer.people.group"));
  // People matching is name/id based; files keep their path search.
  assert.deepEqual(
    peopleAutocomplete(people, "ali").map((option) => option.value),
    ["@Alice "],
  );
  assert.deepEqual(
    peopleAutocomplete(people, "").map((option) => option.id),
    [autocompleteOptionId("person", "u-alice"), autocompleteOptionId("person", "u-bob")],
  );
});

test("people mode is default while people are mentioned, with an Agent escape hatch", () => {
  assert.equal(peopleModeActive({ mentionCount: 1, agentOverride: false, viewOnly: false }), true);
  assert.equal(peopleModeActive({ mentionCount: 2, agentOverride: true, viewOnly: false }), false);
  assert.equal(peopleModeActive({ mentionCount: 0, agentOverride: false, viewOnly: false }), false);
  // A view-only reader has only people mode.
  assert.equal(peopleModeActive({ mentionCount: 0, agentOverride: true, viewOnly: true }), true);
});

test("deleting a mention token removes the person from the request", () => {
  const mentions = [{ userId: "u-alice", name: "Alice" }, { userId: "u-bob", name: "Bob" }];
  assert.equal(livePersonMentions("hi @Alice and @Bob", mentions).length, 2);
  assert.deepEqual(
    livePersonMentions("hi @Alice only", mentions).map((mention) => mention.userId),
    ["u-alice"],
  );
  assert.deepEqual(livePersonMentions("no tokens", mentions), []);
  assert.equal(personMentionToken("Alice"), "@Alice");
});

test("send label names one person or counts several", () => {
  assert.equal(peopleSendLabel([{ userId: "u1", name: "Alice" }]), tr("composer.people.sendToOne", { name: "Alice" }));
  assert.equal(
    peopleSendLabel([{ userId: "u1", name: "Alice" }, { userId: "u2", name: "Bob" }]),
    tr("composer.people.sendToMany", { count: 2 }),
  );
});

test("carry-to-agent toggle is hidden without collaborate access", () => {
  assert.equal(showCarryToAgent({ sharing: { access: "collaborate", shared: true } } as never, false), true);
  assert.equal(showCarryToAgent({ sharing: { access: "manage", shared: true } } as never, false), true);
  assert.equal(showCarryToAgent({ sharing: { access: "view", shared: true } } as never, false), false);
  // No sharing view = own chat = full access.
  assert.equal(showCarryToAgent({} as never, false), true);
  // A view-only composer never carries, even if access changed under it.
  assert.equal(showCarryToAgent({ sharing: { access: "manage", shared: true } } as never, true), false);
  assert.equal(showCarryToAgent(null, false), false);
});
