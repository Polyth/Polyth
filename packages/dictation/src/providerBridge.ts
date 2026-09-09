import {
  normalizeDictationContext,
  normalizeDictationError,
  type DictationProvider,
  type NormalizedSttEvent,
} from "./providers.ts";
import type { SttAdapter, SttStream } from "./streaming.ts";

/** Adapt the public provider-neutral extension contract to Polyth's reliable
 * server-authoritative streaming seam. Vendor/package events stay normalized. */
export function providerToSttAdapter(provider: DictationProvider): SttAdapter {
  return {
    engine: provider.id,
    createStream({ format, language, context }): SttStream {
      const normalized = normalizeDictationContext({
        ...context,
        language: language || context?.language || "auto",
      });
      const session = provider.createSession({
        format,
        context: normalized,
        model: provider.capabilities.defaultModel,
      });
      let latest = "";

      const syncEvents = (): void => {
        const events = session.events?.() ?? [];
        for (let i = events.length - 1; i >= 0; i--) {
          const event: NormalizedSttEvent = events[i]!;
          if (
            event.type === "partial"
            || event.type === "committed"
            || event.type === "commit"
            || event.type === "final"
          ) {
            latest = event.text;
            return;
          }
          if (event.type === "recoverable_error" || event.type === "fatal_error" || event.type === "error") {
            throw event.error;
          }
        }
      };

      return {
        async push(pcm) {
          try {
            await session.push(pcm);
            syncEvents();
          } catch (error) {
            throw normalizeDictationError(error);
          }
        },
        partial() {
          syncEvents();
          return latest;
        },
        async finalize() {
          try {
            latest = await session.finalize();
            syncEvents();
            return latest;
          } catch (error) {
            throw normalizeDictationError(error);
          }
        },
        async cancel() {
          await session.cancel?.();
        },
      };
    },
  };
}
