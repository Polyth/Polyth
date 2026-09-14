import assert from "node:assert/strict";
import test from "node:test";
import type { QuotaRuntime } from "../src/opencodeAuth.ts";
import { createCommandCodeProvider } from "../src/providers/commandcode.ts";
import { listConfiguredQuotaProviders } from "../src/providers/index.ts";

test("Command Code account quota integration fails closed without touching credentials or private APIs", async () => {
  let runtimeTouched = false;
  const runtime = new Proxy({}, {
    get() {
      runtimeTouched = true;
      throw new Error("Command Code quota provider must not access runtime credentials or network helpers");
    },
  }) as QuotaRuntime;

  const provider = createCommandCodeProvider(runtime);
  assert.equal(provider.id, "command-code");
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(
    provider.fetch(new AbortController().signal),
    /not exposed through a documented machine-readable surface/,
  );
  assert.equal(runtimeTouched, false);
});

test("quota registry cannot revive the legacy private Command Code billing adapter", () => {
  const providers = listConfiguredQuotaProviders({
    readAuth: () => ({ "command-code": { key: "do-not-use" } }),
    env: { COMMAND_CODE_API_KEY: "do-not-use" },
    homedir: "/nonexistent/polyth-commandcode-test",
    platform: "linux",
    readFile: () => "",
    readKeychain: () => null,
  });
  assert.equal(providers.includes("command-code"), false);
});
