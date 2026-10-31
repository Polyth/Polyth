// Spoken commands, the queue "send now", the one-tab claim and the new
// preferences — the pieces under the controller that need no microphone.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueueItemDto } from "@polyth/contracts";
import {
  defaultCommandPhrases,
  matchVoiceCommand,
  parsePhraseList,
  resolveCommandPhrases,
} from "../src/commands.ts";
import { parseVoiceModePrefs } from "../src/prefs.ts";
import { sendQueuedNow, stopTurn, type QueueApi } from "../widgets/sessionActions.ts";
import { createTabClaim } from "../widgets/tabClaim.ts";

const phrases = defaultCommandPhrases(["uk-UA", "en"]);

test("a command is the whole utterance, whatever the punctuation and case", () => {
  assert.deepEqual(matchVoiceCommand("Stop.", phrases), { command: "stop", rest: "" });
  assert.deepEqual(matchVoiceCommand("  СТОП! ", phrases), { command: "stop", rest: "" });
  assert.deepEqual(matchVoiceCommand("Відправ вже", phrases), { command: "sendNow", rest: "" });
  assert.deepEqual(matchVoiceCommand("send now", phrases), { command: "sendNow", rest: "", },
    "the longer phrase wins over “send”");
  assert.equal(matchVoiceCommand("", phrases), null);
});

test("send, send now and cancel may close a longer utterance; stop may not", () => {
  assert.deepEqual(matchVoiceCommand("Use the staging database, send now.", phrases),
    { command: "sendNow", rest: "Use the staging database" });
  assert.deepEqual(matchVoiceCommand("Перевір логи, надіслати зараз", phrases),
    { command: "sendNow", rest: "Перевір логи" });
  assert.deepEqual(matchVoiceCommand("rename the helper send", phrases), { command: "send", rest: "rename the helper" });
  assert.deepEqual(matchVoiceCommand("delete everything, cancel", phrases), { command: "cancel", rest: "delete everything" });
  assert.equal(matchVoiceCommand("please don't stop", phrases), null, "a message that ends in “stop” is a message");
  assert.equal(matchVoiceCommand("resend", phrases), null, "only whole words count");
  assert.equal(matchVoiceCommand("stop the server and restart it", phrases), null);
});

test("languages without word spaces match trailing commands too", () => {
  const zh = defaultCommandPhrases(["zh-CN"]);
  assert.deepEqual(matchVoiceCommand("停止。", zh), { command: "stop", rest: "" });
  assert.deepEqual(matchVoiceCommand("修复测试，立即发送。", zh), { command: "sendNow", rest: "修复测试" });
});

test("custom phrases replace a command's defaults; an empty list turns it off", () => {
  const custom = resolveCommandPhrases({ stop: ["halt please"], cancel: [] }, ["en"]);
  assert.deepEqual(matchVoiceCommand("Halt, please!", custom), { command: "stop", rest: "" });
  assert.equal(matchVoiceCommand("stop", custom), null);
  assert.equal(matchVoiceCommand("cancel", custom), null);
  assert.deepEqual(matchVoiceCommand("send now", custom), { command: "sendNow", rest: "" }, "untouched commands keep defaults");
  assert.deepEqual(parsePhraseList(" stop , Stop,, halt\nwait "), ["stop", "halt", "wait"]);
});

test("new preferences parse defensively", () => {
  const prefs = parseVoiceModePrefs(JSON.stringify({
    feedback: "silent",
    commands: false,
    commandPhrases: { stop: ["стоп", 3, "Стоп", " "], sendNow: "not a list", bogus: ["x"] },
  }));
  assert.equal(prefs.feedback, "silent");
  assert.equal(prefs.commands, false);
  assert.deepEqual(prefs.commandPhrases, { stop: ["стоп"] });
  assert.equal(parseVoiceModePrefs(JSON.stringify({ feedback: "loud" })).feedback, "voice");
});

function fakeQueue(items: Array<Partial<QueueItemDto> & { id: string; text: string }>) {
  const calls: string[] = [];
  const api: QueueApi = {
    async abort(sessionId, source) { calls.push(`abort ${sessionId} ${source}`); },
    async queueList() {
      return items.map((item, position) => ({ sessionId: "s1", position, delivery: "queue", createdAt: 0, ...item }) as QueueItemDto);
    },
    async queueSendNow(_sessionId, queueId, text) { calls.push(`now ${queueId} ${JSON.stringify(text)}`); },
    async queueRemove(_sessionId, queueId) { calls.push(`remove ${queueId}`); },
  };
  return { api, calls };
}

test("“send now” merges the plain messages at the head of the queue into one turn", async () => {
  const { api, calls } = fakeQueue([
    { id: "q1", text: "update the docs" },
    { id: "q2", text: "and the changelog" },
    { id: "q3", text: "with this file", attachments: [{ kind: "file", path: "a.md" } as never] },
    { id: "q4", text: "later" },
  ]);
  assert.equal(await sendQueuedNow(api, "s1"), 2);
  assert.deepEqual(calls, [`now q1 ${JSON.stringify("update the docs\n\nand the changelog")}`, "remove q2"],
    "sent before the merged ones are removed; the attachment and what follows keep their place");
});

test("“send now” promotes a non-plain head alone and reports an empty queue", async () => {
  const command = fakeQueue([{ id: "q1", text: "/review", command: { id: "review" } }, { id: "q2", text: "then this" }]);
  assert.equal(await sendQueuedNow(command.api, "s1"), 1);
  assert.deepEqual(command.calls, [`now q1 ${JSON.stringify("/review")}`]);
  const held = fakeQueue([{ id: "q1", text: "old", heldForReview: true }]);
  assert.equal(await sendQueuedNow(held.api, "s1"), 0, "a message held for review is never dispatched");
  const stop = fakeQueue([]);
  await stopTurn(stop.api, "s1");
  assert.deepEqual(stop.calls, ["abort s1 voice"]);
});

test("starting voice mode in one tab is heard by the others, not by itself", () => {
  class Channel {
    static all: Channel[] = [];
    listeners = new Set<(event: MessageEvent) => void>();
    closed = false;
    name: string;
    constructor(name: string) {
      this.name = name;
      Channel.all.push(this);
    }
    postMessage(data: unknown) {
      for (const other of Channel.all) {
        if (other === this || other.closed || other.name !== this.name) continue;
        for (const listener of other.listeners) listener({ data } as MessageEvent);
      }
    }
    addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listeners.add(listener); }
    removeEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listeners.delete(listener); }
    close() { this.closed = true; }
  }
  const scope = {
    BroadcastChannel: Channel as unknown as typeof BroadcastChannel,
    addEventListener() {},
    removeEventListener() {},
  };
  const a = createTabClaim(scope);
  const b = createTabClaim(scope);
  const heard: string[] = [];
  a.onClaimed(() => heard.push("a"));
  b.onClaimed(() => heard.push("b"));
  a.claim();
  assert.deepEqual(heard, ["b"]);
  b.claim();
  assert.deepEqual(heard, ["b", "a"]);
  b.dispose();
  a.claim();
  assert.deepEqual(heard, ["b", "a"], "a disposed tab hears nothing");
  a.dispose();
});
