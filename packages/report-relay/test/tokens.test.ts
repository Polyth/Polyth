import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createReportRelay, type ReportRelayOptions } from "../src/index.ts";
import { authenticate, hashSecret, mint, parseTokens, tokenMap, type TokenRecord } from "../src/tokens.ts";
import { FakeGitHub, PASSWORD, fixture, report, uuid, type Fixture } from "./support.ts";

const SOURCE = "198.51.100.9";

interface Minted {
  keyId: string;
  group: string;
  secret: string;
}

/** Writes `<keysDir>/tokens.json` and returns the full secrets a tester holds. */
function tokensFile(
  base: Fixture,
  entries: Array<{ group: string; keyId?: string; dayCap?: number; disabled?: boolean }>,
): Minted[] {
  const minted = entries.map((entry) => {
    const keyId = entry.keyId ?? entry.group;
    const token = mint(keyId);
    const record: TokenRecord = {
      keyId,
      group: entry.group,
      label: `${entry.group} team`,
      hash: token.hash,
      dayCap: entry.dayCap ?? 40,
      disabled: entry.disabled ?? false,
    };
    return { keyId, group: entry.group, secret: token.secret, record };
  });
  writeFileSync(join(base.keys, "tokens.json"), JSON.stringify({ tokens: minted.map((entry) => entry.record) }));
  return minted.map(({ keyId, group, secret }) => ({ keyId, group, secret }));
}

function relayFor(base: Fixture, options: ReportRelayOptions = {}) {
  const github = new FakeGitHub();
  const relay = createReportRelay({
    keysDir: base.keys,
    dataDir: base.data,
    github,
    allowVersion: () => true,
    pruneAtStart: false,
    ...options,
  });
  return { relay, github };
}

const send = (relay: ReturnType<typeof relayFor>["relay"], body: unknown, secret: string) =>
  relay.report(JSON.stringify(body), SOURCE, `Bearer ${secret}`);

test("a minted token round-trips and only its hash is stored", () => {
  const token = mint("qa-eu");
  assert.match(token.secret, /^qa-eu\.[A-Za-z0-9_-]{43}$/);
  assert.equal(token.hash, hashSecret(token.secret.slice("qa-eu.".length)));
  assert.notEqual(token.hash, token.secret);
  const stored = JSON.stringify({ keyId: token.keyId, group: "qa-eu", hash: token.hash });
  assert.ok(!stored.includes(token.secret), "the entry never carries the secret");

  const records = parseTokens(JSON.stringify({
    tokens: [{ keyId: "qa-eu", group: "qa-eu", label: "QA EU", hash: token.hash, dayCap: 7 }],
  }));
  const identity = authenticate(tokenMap(records), token.secret);
  assert.deepEqual(identity, { keyId: "qa-eu", group: "qa-eu", label: "QA EU", dayCap: 7 });
  assert.equal(authenticate(tokenMap(records), `qa-eu.${"x".repeat(43)}`), null, "a wrong secret is refused");
  assert.equal(authenticate(tokenMap(records), "qa-eu"), null, "the bare key id proves nothing");
});

test("an unreadable entry is dropped instead of being guessed at", () => {
  const good = { keyId: "qa-eu", group: "qa-eu", hash: "a".repeat(64) };
  const records = parseTokens(JSON.stringify({
    tokens: [
      good,
      { ...good, keyId: "qa-eu", group: "other" },
      { ...good, keyId: "Bad Id" },
      { ...good, keyId: "qa-ca", group: "QA CA" },
      { ...good, keyId: "qa-us", hash: "short" },
      { ...good, keyId: "qa-pl", dayCap: 0 },
      { ...good, keyId: "qa-ua", disabled: true },
      "not an object",
    ],
  }));
  assert.deepEqual(records.map((record) => record.keyId), ["qa-eu", "qa-ua"]);
  assert.equal(records[1]!.disabled, true);

  for (const text of ["", "{}", "[]", "not json", JSON.stringify({ tokens: "qa-eu" })]) {
    assert.deepEqual(parseTokens(text), [], text.slice(0, 20));
  }
});

test("the group comes from the token, never from the report body", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const [eu, beta] = tokensFile(base, [{ group: "qa-eu" }, { group: "beta" }]);
  const { relay, github } = relayFor(base);

  assert.deepEqual(await send(relay, report({ text: "Sidebar vanishes" }), eu!.secret), { result: "created", issue: 100 });
  assert.deepEqual(await send(relay, report({ reportId: uuid(2), install: "b".repeat(32), text: "Sidebar vanishes" }), beta!.secret), { result: "created", issue: 101 });

  const euIssue = github.issue(100)!;
  const betaIssue = github.issue(101)!;
  assert.ok(euIssue.labels.includes("group:qa-eu"));
  assert.ok(betaIssue.labels.includes("group:beta"));
  assert.match(euIssue.body, /\| Group \| qa-eu · qa-eu team \|/);
  assert.match(euIssue.body, /<!-- polyth-report fp=[0-9a-f]{16} id=[0-9a-f-]{36} group=qa-eu key=qa-eu -->/);

  // A body field naming another group is not part of the exact wire shape.
  const smuggled = await relay.report(JSON.stringify({ ...report({ reportId: uuid(3) }), group: "beta" }), SOURCE, `Bearer ${eu!.secret}`);
  assert.deepEqual(smuggled, { result: "invalid" });
  assert.equal(github.issues.length, 2);
  relay.close();
});

test("an unknown, disabled or wrong-secret token is refused like a wrong password", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const [eu, gone] = tokensFile(base, [{ group: "qa-eu" }, { group: "old", keyId: "retired", disabled: true }]);
  const { relay, github } = relayFor(base);

  assert.deepEqual(await send(relay, report(), "nope.whatever"), { result: "password" }, "unknown key id");
  assert.deepEqual(await send(relay, report(), `qa-eu.${"z".repeat(43)}`), { result: "password" }, "wrong secret");
  assert.deepEqual(await send(relay, report(), gone!.secret), { result: "password" }, "disabled entry");
  assert.equal(github.issues.length, 0);
  assert.deepEqual(await send(relay, report(), eu!.secret), { result: "created", issue: 100 });
  relay.close();
});

test("the legacy tester password keeps working as the default group", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  tokensFile(base, [{ group: "qa-eu" }]);
  const { relay, github } = relayFor(base);

  assert.deepEqual(
    await relay.report(JSON.stringify(report()), SOURCE, `Bearer ${PASSWORD}`),
    { result: "created", issue: 100 },
  );
  const issue = github.issue(100)!;
  assert.ok(issue.labels.includes("group:default"));
  assert.match(issue.body, /group=default key=default -->/);
  relay.close();
});

test("a token's own daily cap stops it without touching another group", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const [eu, beta] = tokensFile(base, [{ group: "qa-eu", dayCap: 1 }, { group: "beta", dayCap: 5 }]);
  const { relay, github } = relayFor(base);

  assert.deepEqual(await send(relay, report(), eu!.secret), { result: "created", issue: 100 });
  assert.deepEqual(await send(relay, report({ reportId: uuid(2), install: "b".repeat(32) }), eu!.secret), { result: "rate" });
  assert.deepEqual(await send(relay, report({ reportId: uuid(3), install: "c".repeat(32) }), beta!.secret), { result: "created", issue: 101 });
  assert.equal(github.issues.length, 2);
  relay.close();
});

test("a repeat from a second group names both groups on the open issue", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const [eu, beta] = tokensFile(base, [{ group: "qa-eu" }, { group: "beta" }]);
  const { relay, github } = relayFor(base);
  const errors = [{ time: new Date().toISOString(), text: "Error: window froze\nCode: E_FREEZE\nComponent: chat" }];

  assert.deepEqual(await send(relay, report({ errors }), eu!.secret), { result: "created", issue: 100 });
  assert.deepEqual(await send(relay, report({ reportId: uuid(2), errors }), beta!.secret), { result: "added", issue: 100 });

  assert.equal(github.issues.length, 1, "one fingerprint, one issue");
  const comment = github.comments[0]!.body;
  assert.match(comment, /Group: beta · beta team/);
  assert.match(comment, /Seen in groups: beta, qa-eu/);
  relay.close();
});

test("the token never reaches the state, the log or a GitHub payload", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const [eu] = tokensFile(base, [{ group: "qa-eu" }]);
  const logs: unknown[] = [];
  const { relay, github } = relayFor(base, { logger: (event) => logs.push(event) });
  await send(relay, report({ screenshot: null }), eu!.secret);

  const files = JSON.stringify(github.uploads.map((upload) => Buffer.from(upload.content, "base64").toString("utf8")));
  const bodies = JSON.stringify(github.issues.map((issue) => issue.body));
  for (const text of [files, bodies, JSON.stringify(logs)]) {
    assert.ok(!text.includes(eu!.secret), "the secret is only ever the bearer header");
    assert.ok(!text.includes(eu!.secret.slice(eu!.keyId.length + 1)), "not even the secret half");
  }
  relay.close();
});
