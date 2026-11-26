import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";
import { codexIdentityFromAuth, readCodexAccountIdentity } from "../src/accountIdentity.ts";
import { codexAccountListStatus } from "../src/serverEntry.ts";

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${part({ alg: "RS256" })}.${part(claims)}.c2lnbmF0dXJl`;
const authFile = (claims: Record<string, unknown>) => JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: jwt(claims), access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", account_id: "acc_1" },
  last_refresh: "2026-11-26T10:00:00Z",
});
const chatgpt = { email: "work@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acc_1" } };

test("a ChatGPT login's ID token gives its email and plan, and nothing else", () => {
  const identity = codexIdentityFromAuth(authFile(chatgpt));
  assert.deepEqual(identity, { email: "work@example.com", plan: "plus" });
  assert.doesNotMatch(JSON.stringify(identity), /fixture-|acc_1/, "no token or account id leaves the reader");
  assert.deepEqual(
    codexIdentityFromAuth(authFile({ "https://api.openai.com/profile": { email: "home@example.com" } })),
    { email: "home@example.com" },
    "the profile claim stands in for a missing top-level email",
  );
});

test("an API key, a malformed file or odd claims give no identity", () => {
  assert.deepEqual(codexIdentityFromAuth(JSON.stringify({ OPENAI_API_KEY: "sk-fixture" })), {});
  assert.deepEqual(codexIdentityFromAuth("{not json"), {});
  assert.deepEqual(codexIdentityFromAuth(JSON.stringify({ tokens: { id_token: "not-a-jwt" } })), {});
  assert.deepEqual(codexIdentityFromAuth(JSON.stringify({ tokens: { id_token: "a.%%%.c" } })), {});
  assert.deepEqual(codexIdentityFromAuth(authFile({ email: "no at sign", "https://api.openai.com/auth": { chatgpt_plan_type: "plus\nInjected" } })), {});
  assert.deepEqual(codexIdentityFromAuth(authFile({ email: ["a@b.c"] })), {});
});

test("the accounts list adds the identity to a signed-in login only", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-codex-identity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const signedInMarker = join(root, "signed-in");
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/bin/sh
case "$1" in
  login) if [ -f "${signedInMarker}" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in" >&2; exit 1; fi ;;
  *) echo "unexpected codex $*" >&2; exit 9 ;;
esac
`);
  chmodSync(codex, 0o755);
  const saved = process.env.POLYTH_CODEX_BIN;
  process.env.POLYTH_CODEX_BIN = codex;
  t.after(() => {
    if (saved === undefined) delete process.env.POLYTH_CODEX_BIN;
    else process.env.POLYTH_CODEX_BIN = saved;
  });
  const dir = join(root, "accounts", "2");
  mkdirSync(dir, { recursive: true });
  const account: ResolvedHarnessAccount = { id: "2", harnessId: "codex-2", name: "Account 2", dir };

  writeFileSync(join(dir, "auth.json"), authFile(chatgpt));
  assert.deepEqual(await codexAccountListStatus(account), { loggedIn: false }, "a signed-out login shows no leftover identity");

  writeFileSync(signedInMarker, "");
  assert.deepEqual(await codexAccountListStatus(account), { loggedIn: true, email: "work@example.com", plan: "plus" });

  rmSync(join(dir, "auth.json"));
  assert.deepEqual(await codexAccountListStatus(account), { loggedIn: true, plan: "ChatGPT" }, "credentials in the OS keyring keep the CLI's own answer");
  assert.deepEqual(await readCodexAccountIdentity(join(root, "missing")), {});
});
