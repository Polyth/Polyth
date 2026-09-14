import assert from "node:assert/strict";
import test from "node:test";
import type { QuotaRuntime } from "../src/opencodeAuth.ts";
import { createCommandCodeProvider } from "../src/providers/commandcode.ts";

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
