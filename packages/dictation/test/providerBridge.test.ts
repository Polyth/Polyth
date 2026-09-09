import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRegistry,
  providerCapabilities,
  type DictationProvider,
  type NormalizedSttEvent,
} from "../src/providers.ts";
import { providerToSttAdapter } from "../src/providerBridge.ts";

const format = { encoding: "pcm_s16le" as const, sampleRate: 16_000, channels: 1 };

test("a private Wispr provider can register without a core/server patch", async () => {
  const events: NormalizedSttEvent[] = [];
  const seen: Uint8Array[] = [];
  const provider: DictationProvider = {
    id: "wispr",
    capabilities: providerCapabilities("wispr")!,
    available: () => ({ available: true }),
    createSession({ context }) {
      assert.equal(context.language, "uk-UA");
      assert.deepEqual(context.keywords, ["Polyth"]);
      return {
        push(pcm) {
          seen.push(pcm.slice());
          events.push({ type: "partial", text: "привіт", revision: 1 });
        },
        events: () => events,
        finalize: async () => "привіт Polyth",
      };
    },
  };

  const registry = new ProviderRegistry().register(provider);
  const registered = registry.get("wispr");
  assert.ok(registered);
  const stream = providerToSttAdapter(registered).createStream({
    format,
    language: "uk-UA",
    context: { language: "auto", keywords: ["Polyth"] },
  });
  await stream.push(new Uint8Array([1, 0]));
  assert.equal(stream.partial?.(), "привіт");
  assert.equal(await stream.finalize(), "привіт Polyth");
  assert.equal(seen.length, 1);
});
