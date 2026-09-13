import { useEffect } from "react";
import { normalizeModelDescriptor } from "../modelPresentation.ts";
import { setModels, useStore } from "../store.ts";

/**
 * Runtime adapters do not share a presentation contract for model names. Some
 * return a real display name while others echo the wire id. Normalize that
 * catalog once at the web-shell boundary so chat, activity, subagents and
 * session chrome all consume the same human label without per-harness UI
 * exceptions.
 */
export default function ModelPresentationNormalizer() {
  const models = useStore((state) => state.models);

  useEffect(() => {
    let changed = false;
    const normalized = models.map((model) => {
      const next = normalizeModelDescriptor(model);
      if (next !== model) changed = true;
      return next;
    });
    if (changed) setModels(normalized);
  }, [models]);

  return null;
}
