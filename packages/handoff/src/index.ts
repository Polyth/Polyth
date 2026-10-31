import type { JsonObject } from "@polyth/contracts";

export { estimateTokens } from "./tokens.ts";
export { hashText } from "./hash.ts";
export { HANDOFF_PRESETS, presetById, mergePresetSources } from "./presets.ts";
export {
  bundleCopyText,
  bundleSectionsForCopy,
  renderBundleMarkdown,
  newBundleSectionId,
} from "./bundleRender.ts";

export interface ContextCollectInput {
  space: import("@polyth/contracts").SpaceContext;
  projectId: string;
  sessionId: string;
  params?: JsonObject;
}

export interface ContextSection {
  title: string;
  body: string;
  fingerprint: string;
  tokens: number;
}

export interface ContextCollectResult {
  sections: ContextSection[];
  status: "ok" | "missing" | "error";
  error?: string;
  omission?: {
    total: number;
    included: number;
    omitted: number;
    reason: string;
  };
}

export interface ContextSourceProvider {
  id: string;
  label: string;
  description: string;
  defaultOn?: boolean;
  collect(ctx: ContextCollectInput): Promise<ContextCollectResult>;
}

export interface ContextSourceRegistry {
  register(provider: ContextSourceProvider): void;
  list(): ContextSourceProvider[];
  get(id: string): ContextSourceProvider | undefined;
}

export function createContextSourceRegistry(): ContextSourceRegistry {
  const providers = new Map<string, ContextSourceProvider>();
  return {
    register(provider) {
      providers.set(provider.id, provider);
    },
    list() {
      return [...providers.values()];
    },
    get(id) {
      return providers.get(id);
    },
  };
}
