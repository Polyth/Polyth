import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RelayPoolCard, relayPoolSentence } = await import("../widgets/usage/RelayPoolCard.tsx");
const { relayBadgeFor, nextRefill, includedMembers, withDefaultName } = await import("../widgets/usage/relayClient.ts");

const now = new Date(2026, 10, 25, 12, 0).getTime();
const relay = {
  id: "claude-relay", family: "claude", label: "Claude Code",
  members: [
    { harnessId: "claude-max", name: "Claude Code · Max", included: true, position: 3, state: "exhausted", reason: "limit", refillsAt: now + 7 * 3_600_000, tightest: { label: "5h", remaining: 0, resetsAt: now + 7 * 3_600_000 } },
    { harnessId: "claude", name: "Claude Code", included: true, position: 1, state: "now", tightest: { label: "5h", remaining: 0.62 } },
    { harnessId: "claude-iryna", name: "Claude Code · Iryna", included: true, position: 2, state: "next" },
    { harnessId: "claude-team", name: "Claude Code · Team", included: false, state: "skipped" },
  ],
} as never;

test("pool members sort by plan position and the sentence names now, next and the refill with no percentage", () => {
  assert.deepEqual(includedMembers(relay).map((member) => member.harnessId), ["claude", "claude-iryna", "claude-max"]);
  const sentence = relayPoolSentence(relay, now);
  assert.match(sentence, /^Claude Code runs now · then Iryna · Max refills /);
  assert.doesNotMatch(sentence, /%/);
  assert.equal(nextRefill(relay)?.member.harnessId, "claude-max");
});

test("pool card renders one segment per included member, marks unknown readings and renders nothing without members", () => {
  const html = renderToStaticMarkup(createElement(RelayPoolCard, { relay, now }));
  assert.match(html, /Claude Code · Relay/);
  assert.equal((html.match(/usage-relay-seg"/g) ?? []).length, 3);
  assert.match(html, /data-state="now"/);
  assert.match(html, /no reading/);
  assert.match(html, /62% left/);
  assert.match(html, /refills /);
  assert.equal(renderToStaticMarkup(createElement(RelayPoolCard, { relay: { ...(relay as object), members: [] } as never, now })), "");
});

test("per-account cards get a Relay badge only for included members", () => {
  assert.deepEqual(relayBadgeFor([relay], "claude-iryna"), { n: 2, state: "next" });
  assert.equal(relayBadgeFor([relay], "claude-team"), undefined);
});

test("the family's own login reads Default in the pool", () => {
  const input = relay as Parameters<typeof withDefaultName>[0];
  const named = withDefaultName(input);
  assert.equal(named.members.find((member) => member.harnessId === "claude")?.name, "Default");
  assert.equal(named.members.find((member) => member.harnessId === "claude-iryna")?.name, input.members.find((member) => member.harnessId === "claude-iryna")?.name);
});
