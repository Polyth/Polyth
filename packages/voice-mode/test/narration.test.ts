// What voice mode says while the agent works: steps grouped into key moments
// or said one by one, failures at once, thoughts by headline or in full, and
// nothing waiting once the reply starts. A fake clock drives the cadence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES } from "@polyth/contracts";
import type { ToolActivityDescription } from "@polyth/web-sdk";
import {
  NARRATION_GAP_MS,
  NARRATION_GROUP_MS,
  NARRATION_PHRASES,
  actionPhrase,
  createNarrationTracker,
  defaultVoiceModePrefs,
  fallbackDescribe,
  firstThoughtSentence,
  narrationLocale,
  narrationPhrases,
  parseVoiceModePrefs,
  thoughtHeadlines,
  type NarrationSettings,
} from "../src/index.ts";

const en = narrationPhrases("en");

/** A stand-in for the host classifier: the tool name is the kind, `path` the file. */
const describe = (tool: string, input: Readonly<Record<string, unknown>>): ToolActivityDescription => {
  const path = typeof input.path === "string" ? input.path.split("/").at(-1) : undefined;
  return { kind: tool as ToolActivityDescription["kind"], ...(path ? { target: path } : {}) };
};

function setup(settings: Partial<NarrationSettings> = {}) {
  let clock = 1_000_000;
  const current: NarrationSettings = { thoughts: "off", actions: true, cadence: "key", ...settings };
  const tracker = createNarrationTracker({ describe, phrases: () => en, settings: () => current, now: () => clock });
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>) => tracker.accept({ sessionId: "s1", seq: ++seq, type, data });
  const tool = (callId: string, name: string, path?: string) =>
    event("tool/call", { callId, tool: name, status: "running", input: path ? { path } : {} });
  return {
    tracker, event, tool, current,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    texts: (cues: ReadonlyArray<{ text: string }>) => cues.map((cue) => cue.text),
  };
}

test("key moments group the steps of a short window into one remark, the latest kinds in order", () => {
  const h = setup();
  assert.deepEqual(h.tool("c1", "read", "src/a.ts"), [], "a step waits for its window");
  assert.equal(h.tracker.nextDueAt(), h.now() + NARRATION_GROUP_MS);
  h.advance(500);
  h.tool("c2", "read", "src/b.ts");
  h.tool("c2", "read", "src/b.ts");
  h.tool("c3", "test");
  assert.deepEqual(h.tracker.due(), [], "nothing before the window closes");
  h.advance(NARRATION_GROUP_MS);
  assert.deepEqual(h.texts(h.tracker.due()), ["Reading files. Running the tests."],
    "two files read are said as one bare step; a repeated call id is not counted twice");
  assert.equal(h.tracker.nextDueAt(), null);

  h.advance(1_000);
  h.tool("c4", "edit", "src/a.ts");
  assert.equal(h.tracker.nextDueAt(), h.now() - 1_000 + NARRATION_GAP_MS,
    "the next remark keeps the gap after the last one");
  h.advance(NARRATION_GAP_MS);
  assert.deepEqual(h.texts(h.tracker.due()), ["Editing a.ts."]);
});

test("every step is said as it starts, and a failure is said at once in either cadence", () => {
  const h = setup({ cadence: "every" });
  assert.deepEqual(h.texts(h.tool("c1", "read", "docs/readme.md")), ["Reading readme.md."]);
  assert.deepEqual(h.texts(h.tool("c2", "shell")), ["Running a command."]);
  const key = setup();
  key.tool("c1", "read", "a.ts");
  const failed = key.event("tool/error", { callId: "c2", tool: "test", error: "exit 1" });
  assert.deepEqual(failed.map(({ text, urgent }) => [text, urgent]), [["The tests failed.", true]]);
  assert.equal(key.tracker.nextDueAt(), null, "what waited is dropped: the failure is the news");
  assert.deepEqual(key.texts(key.event("tool/error", { callId: "c3", tool: "edit", error: "denied" })), ["A step failed."]);
});

test("the reply drops what waits, and nothing is said with narration off", () => {
  const h = setup();
  h.tool("c1", "read", "a.ts");
  h.event("assistant/chunk", { partId: "p1", text: "Found it." });
  h.advance(NARRATION_GROUP_MS);
  assert.deepEqual(h.tracker.due(), []);

  const off = setup({ actions: false });
  assert.deepEqual(off.tool("c1", "read", "a.ts"), []);
  assert.deepEqual(off.event("tool/error", { callId: "c1", tool: "read", error: "x" }), []);
  assert.deepEqual(off.event("assistant/reasoning-chunk", { partId: "r1", text: "I should check the config.\n" }), [],
    "thoughts are off by default");
  assert.equal(off.tracker.nextDueAt(), null);
});

test("brief thoughts say each headline, or the first sentence of a thought without one", () => {
  const h = setup({ actions: false, thoughts: "brief", cadence: "every" });
  assert.deepEqual(h.event("assistant/reasoning-chunk", { partId: "r1", text: "**Planning the" }), []);
  assert.deepEqual(h.texts(h.event("assistant/reasoning-chunk", { partId: "r1", text: " fix**\n\nThe test uses" })), ["Planning the fix"]);
  assert.deepEqual(h.event("assistant/reasoning-chunk", { partId: "r1", text: " an old name. More detail.\n" }), [],
    "a part with headlines is not also read by its sentences");
  assert.deepEqual(h.texts(h.event("assistant/reasoning-chunk", { partId: "r1", text: "**Checking `tests`**\n" })), ["Checking tests"]);

  assert.deepEqual(h.texts(h.event("assistant/reasoning-chunk", { partId: "r2", text: "I need to look at the parser first. Then" })),
    ["I need to look at the parser first."]);
  assert.deepEqual(h.event("assistant/reasoning-chunk", { partId: "r2", text: " the tests." }), [], "once per thought");

  h.event("assistant/reasoning-chunk", { partId: "r3", text: "Maybe the cache" });
  assert.deepEqual(h.texts(h.tool("c1", "read")), ["Maybe the cache"], "a thought cut short by a step is said as it stands");

  const key = setup({ actions: false, thoughts: "brief" });
  key.event("assistant/reasoning-chunk", { partId: "r1", text: "**One**\n**Two**\n" });
  key.advance(NARRATION_GROUP_MS);
  assert.deepEqual(key.texts(key.tracker.due()), ["Two"], "key moments say only the newest headline");
});

test("full thoughts are read sentence by sentence as they stream", () => {
  const h = setup({ actions: false, thoughts: "full" });
  const said = h.texts([
    ...h.event("assistant/reasoning-chunk", { partId: "r1", text: "The failing test compares two snapshots taken at different times. " }),
    ...h.event("assistant/reasoning-chunk", { partId: "r1", text: "So the fix is to freeze the clock before both of them are taken. And" }),
  ]);
  assert.ok(said.length >= 1 && said.join(" ").startsWith("The failing test compares"), said.join(" | "));
  assert.equal(h.tracker.nextDueAt(), null, "full thoughts never wait for a window");
  const rest = h.texts(h.tool("c1", "read"));
  assert.ok(rest.join(" ").endsWith("And"), "the unfinished tail is said when the agent moves on");
  assert.deepEqual(h.event("assistant/message", { partId: "m1", text: "Done.", reasoning: "Unstreamed thoughts." }), [],
    "reasoning that only arrives with the final message is never read");
});

test("thought helpers find headlines and cut long first sentences at a word", () => {
  assert.deepEqual(thoughtHeadlines("## Plan\ntext\n**Next step**\n**Unfinished", false), ["Plan", "Next step"]);
  assert.equal(firstThoughtSentence("Short and still", false), null);
  assert.equal(firstThoughtSentence("Short and still", true), "Short and still");
  const long = firstThoughtSentence(`${"word ".repeat(60)}end.`, false)!;
  assert.ok(long.length <= 161 && long.endsWith("…"), long);
});

test("steps read naturally with or without a subject, and the fallback names the tool", () => {
  assert.equal(actionPhrase({ kind: "read", target: "config.ts" }, en), "Reading config.ts");
  assert.equal(actionPhrase({ kind: "read", target: "config.ts" }, en, true), "Reading files");
  assert.equal(actionPhrase({ kind: "create" }, en), "Writing files");
  assert.equal(actionPhrase({ kind: "plan" }, en), "Updating the plan");
  assert.deepEqual(fallbackDescribe("mcp__linear_create"), { kind: "tool", target: "linear create" });
  assert.equal(actionPhrase({ kind: "search", target: "parseConfig" }, narrationPhrases("uk")), "Шукаю «parseConfig»");
});

test("every locale has the narration phrases, and speech languages map to them", () => {
  for (const locale of LOCALES) {
    const phrases = NARRATION_PHRASES[locale];
    assert.deepEqual(Object.keys(phrases).sort(), Object.keys(en).sort(), locale);
    for (const key of ["read", "edit", "write", "delete", "search", "web", "mcp", "shell", "tool"] as const) {
      assert.ok(phrases[key].includes("{target}"), `${locale}.${key}`);
    }
  }
  assert.equal(narrationLocale("uk-UA", "en"), "uk");
  assert.equal(narrationLocale("pt-PT", "en"), "pt");
  assert.equal(narrationLocale("pt-BR", "en"), "pt-BR");
  assert.equal(narrationLocale("zh-TW", "en"), "zh-CN");
  assert.equal(narrationLocale("ja-JP", "de"), "de", "a language Polyth has no catalog for uses the UI's");
});

test("narration is off by default, and settings a client does not know survive a save", () => {
  const defaults = defaultVoiceModePrefs();
  assert.equal(defaults.thoughts, "off");
  assert.equal(defaults.actions, false);
  assert.equal(defaults.narrationCadence, "key");
  const parsed = parseVoiceModePrefs(JSON.stringify({ thoughts: "full", actions: true, narrationCadence: "every", narrator: "model", replyVoice: "soft" }));
  assert.equal(parsed.thoughts, "full");
  assert.equal(parsed.actions, true);
  assert.equal(parsed.narrationCadence, "every");
  assert.equal(parsed.narrator, "model");
  assert.equal(defaults.narrator, "templates", "simple phrases unless the small model is chosen");
  assert.equal((parsed as unknown as Record<string, unknown>).replyVoice, "soft",
    "a newer client's key is carried through, not erased");
  assert.equal(parseVoiceModePrefs(JSON.stringify({ thoughts: "loud", narrationCadence: 3 })).thoughts, "off");
});
