import { defineWebPackage } from "@polyth/web-sdk";
import type { EditorIntelligenceProvider } from "@polyth/editor/intelligence";
import { createTypeScriptIntelligence } from "../src/index.ts";

/** Must match EDITOR_INTELLIGENCE_CHANGED_EVENT in
 *  packages/editor/widgets/intelligence.ts; the editor re-reads the slot when
 *  it fires, so a provider that appears or disappears mid-session takes effect
 *  without a reload. A test asserts the two literals agree. */
const EDITOR_INTELLIGENCE_CHANGED_EVENT = "polyth:editor-intelligence";

function announce(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EDITOR_INTELLIGENCE_CHANGED_EVENT));
}

export default defineWebPackage((host) => () => {
  const provider: EditorIntelligenceProvider = createTypeScriptIntelligence();
  const off = host.slots.register({
    slot: "editor.intelligence",
    id: "code-intelligence.typescript",
    render: () => null,
    meta: { provider },
  });
  announce();
  return () => {
    off();
    announce();
  };
});
