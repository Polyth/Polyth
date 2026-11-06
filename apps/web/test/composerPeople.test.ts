// Composer people mode: one @ picker with People first, mode/label decisions,
// and the carry toggle's collaborate gate. Pure (localStorage shimmed).
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionMentionCandidateDto } from "@polyth/contracts";
import type { ComposerPersonMention } from "../src/composer/people.ts";

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
  addressedMentions, awaitingAccessAnswer, defaultMentionLevel, livePersonMentions, mentionAccessLine,
  peopleModeActive, peopleSendLabel, personMessageRecipients, showCarryToAgent, withoutGrantedAnswers,
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

test("@ picker lists the rest of the Space under its own heading, after the people in the chat", () => {
  const outsiders = [{ userId: "u-cara", name: "Cara Bell" }, { userId: "u-dan", name: "Dan" }];
  const view = mentionAndFileAutocomplete(people, "", "idle", [], outsiders);
  const groups = groupAutocompleteOptions(view.options);
  assert.deepEqual(groups.map((group) => group.id), ["people", "people-outside"]);
  assert.equal(groups[1]?.label, tr("composer.people.outsideGroup"));
  const cara = groups[1]!.options[0]!;
  assert.deepEqual(cara.person, { userId: "u-cara", name: "Cara Bell", token: "@Cara", outside: true });
  // The heading says it; a row is only a name.
  assert.equal(cara.detail, "");
  assert.equal(groups[0]!.options[0]!.person?.outside, undefined);

  // A private chat has only the second group, and no files title above it.
  const privateChat = mentionAndFileAutocomplete([], "", "idle", [], outsiders);
  assert.deepEqual(groupAutocompleteOptions(privateChat.options).map((group) => group.id), ["people-outside"]);
  assert.equal(privateChat.status, null);

  // People search covers both lists; files keep their own group after them.
  const search = mentionAndFileAutocomplete(people, "a", "done", [{ path: "src/a.ts", kind: "file" }], outsiders);
  assert.deepEqual(groupAutocompleteOptions(search.options).map((group) => group.id), ["people", "people-outside", "files"]);
});

test("someone in both lists counts as in the chat, and a first name that clashes across them spells out", () => {
  const options = peopleAutocomplete(
    [{ userId: "u-ann", name: "Ann Lee", access: "view" }],
    "",
    [{ userId: "u-ann", name: "Ann Lee" }, { userId: "u-ann2", name: "Ann Bell" }],
  );
  assert.deepEqual(options.map((option) => [option.person?.userId, option.person?.outside ?? false, option.person?.token]), [
    ["u-ann", false, "@Ann_Lee"],
    ["u-ann2", true, "@Ann_Bell"],
  ]);
});

test("an outside mention waits for an answer only while someone can act on it", () => {
  const inside = { userId: "u-a", name: "Alice" };
  const waiting = { userId: "u-b", name: "Bob", outside: true };
  const granted = { ...waiting, userId: "u-c", accessAnswer: "granted" as const };
  const skipped = { ...waiting, userId: "u-d", accessAnswer: "skipped" as const };
  const all = [inside, waiting, granted, skipped];
  assert.deepEqual(awaitingAccessAnswer(all, "share").map((mention) => mention.userId), ["u-b"]);
  assert.deepEqual(awaitingAccessAnswer(all, "request").map((mention) => mention.userId), ["u-b"]);
  assert.deepEqual(awaitingAccessAnswer(all, "none"), []);
  assert.deepEqual(awaitingAccessAnswer(all, undefined), []);
  // Whom the send button names: not the skipped, and nobody nobody can reach.
  assert.deepEqual(addressedMentions(all, "share").map((mention) => mention.userId), ["u-a", "u-b", "u-c"]);
  assert.deepEqual(addressedMentions(all, "none").map((mention) => mention.userId), ["u-a"]);
});

test("a send names outsiders only through the way they get in", () => {
  const all = [
    { userId: "u-a", name: "Alice" },
    { userId: "u-b", name: "Bob", outside: true, accessAnswer: "granted" as const },
    { userId: "u-c", name: "Cara", outside: true, accessAnswer: "skipped" as const },
  ];
  assert.deepEqual(personMessageRecipients(all, "share", "collaborate"), {
    mentions: ["u-a", "u-b"],
    shareWith: [{ userId: "u-b", access: "collaborate" }],
  });
  assert.deepEqual(personMessageRecipients(all, "request", "view"), {
    mentions: ["u-a", "u-b"],
    requestAccessFor: ["u-b"],
  });
  assert.deepEqual(personMessageRecipients(all, "none", "view"), { mentions: ["u-a"] });
  assert.deepEqual(personMessageRecipients([], "share", "view"), {});
});

test("a change of what the sender can do asks again, but a refusal stands", () => {
  const mentions: ComposerPersonMention[] = [
    { userId: "u-in", name: "In" },
    { userId: "u-yes", name: "Yes", outside: true, accessAnswer: "granted" },
    { userId: "u-no", name: "No", outside: true, accessAnswer: "skipped" },
  ];
  const next = withoutGrantedAnswers(mentions);
  assert.deepEqual(next.map((mention) => mention.accessAnswer), [undefined, undefined, "skipped"]);
  assert.deepEqual(awaitingAccessAnswer(next, "share").map((mention) => mention.userId), ["u-yes"]);
  assert.equal(personMessageRecipients(next, "share", "view").shareWith, undefined);
});

test("a new person gets the least access, except that a conversation takes equals", () => {
  assert.equal(defaultMentionLevel(["view", "collaborate", "manage"], false), "view");
  assert.equal(defaultMentionLevel(["view", "collaborate", "manage"], true), "collaborate");
  assert.equal(defaultMentionLevel(["view"], true), "view");
  assert.equal(defaultMentionLevel([], false), "view");
});

test("the line asks first, then says what the message will do, and only for people", () => {
  const waiting = { userId: "u-b", name: "Bob", outside: true };
  const granted = { userId: "u-c", name: "Cara", outside: true, accessAnswer: "granted" as const };
  const skipped = { userId: "u-d", name: "Dan", outside: true, accessAnswer: "skipped" as const };
  assert.equal(mentionAccessLine([{ userId: "u-a", name: "Alice" }], "share", true), null);
  assert.equal(mentionAccessLine([waiting], "share", false), null, "the agent is being addressed");
  assert.equal(mentionAccessLine([waiting], undefined, true), null);
  assert.deepEqual(mentionAccessLine([granted, waiting], "share", true), { state: "ask", action: "share", people: [waiting] });
  assert.deepEqual(mentionAccessLine([granted, skipped], "request", true), { state: "granted", action: "request", people: [granted] });
  assert.equal(mentionAccessLine([skipped], "share", true), null);
  assert.deepEqual(mentionAccessLine([waiting, skipped], "none", true), { state: "blocked", people: [waiting] });
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
