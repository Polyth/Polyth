import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createCodexProvider } from "../src/serverEntry.ts";

// A fixture `codex` answering the version and the local login report. It
// fails loudly if anything tries to start the App Server.
const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-codex-probe-")));
const signedInMarker = join(root, "signed-in");
const codex = join(root, "codex");
writeFileSync(codex, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 1.2.3" ;;
  login) if [ -f "${signedInMarker}" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in" >&2; exit 1; fi ;;
  *) echo "unexpected codex $*" >&2; exit 9 ;;
esac
`);
chmodSync(codex, 0o755);
const context: HarnessContext = { spaceId: "s", projectId: "p", cwd: root };

test("the cheap Codex probe reads sign-in from the CLI's local report, never the App Server", async (t) => {
  const saved = {
    POLYTH_CODEX_BIN: process.env.POLYTH_CODEX_BIN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_API_KEY: process.env.CODEX_API_KEY,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.POLYTH_CODEX_BIN = codex;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  const provider = createCodexProvider({} as ServerPackageHost);

  const signedOut = await provider.probe(context);
  assert.equal(signedOut.state, "auth-required");
  assert.equal(signedOut.authenticated, false);
  assert.equal(signedOut.version, "codex-cli 1.2.3");
  assert.equal(signedOut.message, "Codex is not signed in");

  writeFileSync(signedInMarker, "");
  const signedIn = await provider.probe(context);
  assert.equal(signedIn.state, "ready");
  assert.equal(signedIn.authenticated, true);
  assert.equal(signedIn.message, undefined);

  process.env.OPENAI_API_KEY = "fixture-key";
  const keyed = await provider.probe(context);
  assert.equal(keyed.state, "unknown", "with an API key the App Server decides readiness during discovery");
  assert.equal(keyed.authenticated, "unknown");
});
