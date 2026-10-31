import { randomUUID } from "node:crypto";
import type {
  ContextBundleDto,
  ContextBundleOmissionDto,
  ContextBundleSectionDto,
  JsonObject,
} from "@polyth/contracts";
import { roleAtLeast, type SpaceRole, type SpaceStorage } from "@polyth/contracts";
import {
  estimateTokens,
  type ContextSourceRegistry,
  type ContextCollectInput,
} from "./index.ts";
import { newBundleSectionId, renderBundleMarkdown } from "./bundleRender.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export interface BundleMetadata {
  id: string;
  projectId: string;
  sessionId: string;
  presetId: string;
  label: string;
  fingerprints: Record<string, string>;
  sourceIds: string[];
  createdAt: number;
}

/** Server-side record; `createdBy` never leaves the service. */
interface StoredMetadata extends BundleMetadata {
  /** Absent only on bundles from before ownership was recorded. */
  createdBy?: string;
}

/** Who is asking. Bundles are private to the person who made them (Spaces §14.6). */
export interface BundleViewer {
  userId: string;
  role: SpaceRole;
  /** Can this person open the session? (`host.forSpace(space).sessions.snapshot`) */
  canOpenSession(sessionId: string): Promise<boolean>;
}

export interface BundleServiceOptions {
  registry: ContextSourceRegistry;
  warnTokenThreshold: number;
  now?: () => number;
  ttlMs?: number;
}

const memoryBundles = new Map<string, ContextBundleDto>();
const memoryMeta = new Map<string, StoredMetadata>();

const MAX_BUNDLES_PER_SPACE = 12;
const DEFAULT_BUNDLE_TTL_MS = 60 * 60_000;

function createBundleServiceInternals(opts: BundleServiceOptions) {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? DEFAULT_BUNDLE_TTL_MS;

  function pruneBundles(spaceId: string): void {
    const current = now();
    for (const [key, meta] of [...memoryMeta.entries()]) {
      if (!key.startsWith(`${spaceId}:`)) continue;
      if (current - meta.createdAt > ttlMs) {
        memoryMeta.delete(key);
        memoryBundles.delete(key);
      }
    }
    // The cap is per person: one member's bundles must not evict another's.
    const byOwner = new Map<string, Array<[string, StoredMetadata]>>();
    for (const entry of memoryMeta.entries()) {
      if (!entry[0].startsWith(`${spaceId}:`)) continue;
      const owner = entry[1].createdBy ?? "";
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), entry]);
    }
    for (const owned of byOwner.values()) {
      owned.sort((a, b) => b[1].createdAt - a[1].createdAt);
      for (const [key] of owned.slice(MAX_BUNDLES_PER_SPACE)) {
        memoryMeta.delete(key);
        memoryBundles.delete(key);
      }
    }
  }

  return { now, pruneBundles };
}

/**
 * A bundle is visible to its creator, and to anyone who can open the session it
 * was built from (they could read the same conversation anyway). A bundle with
 * no recorded creator is visible to Space admins only.
 */
async function canSee(meta: StoredMetadata | undefined, viewer: BundleViewer): Promise<boolean> {
  if (!meta) return false;
  if (!meta.createdBy) return roleAtLeast(viewer.role, "admin");
  if (meta.createdBy === viewer.userId) return true;
  try {
    return await viewer.canOpenSession(meta.sessionId);
  } catch {
    return false;
  }
}

function bundleKey(spaceId: string, bundleId: string): string {
  return `${spaceId}:${bundleId}`;
}

export function createBundleService(opts: BundleServiceOptions) {
  const { now, pruneBundles } = createBundleServiceInternals(opts);

  return {
    async createBundle(input: {
      storage: SpaceStorage;
      collectCtx: ContextCollectInput;
      projectId: string;
      sessionId: string;
      presetId: string;
      label: string;
      instruction: string;
      sources: Array<{ id: string; params?: JsonObject }>;
      warnTokenThreshold?: number;
      /** The signed-in person making it; recorded as the bundle's owner. */
      createdBy: string;
    }): Promise<ContextBundleDto> {
      const sections: ContextBundleSectionDto[] = [];
      const sourceRows = [];
      const fingerprints: Record<string, string> = {};
      const omissions: ContextBundleOmissionDto[] = [];
      let totalTokens = estimateTokens(input.instruction);

      for (const source of input.sources) {
        const provider = opts.registry.get(source.id);
        if (!provider) {
          sourceRows.push({
            id: source.id,
            params: source.params,
            tokens: 0,
            fingerprint: "",
            status: "missing" as const,
            error: "source not registered",
          });
          continue;
        }
        const result = await provider.collect({ ...input.collectCtx, params: source.params });
        if (result.omission) {
          omissions.push({
            sourceId: source.id,
            label: provider.label,
            total: result.omission.total,
            included: result.omission.included,
            omitted: result.omission.omitted,
            reason: result.omission.reason,
          });
        }
        for (const section of result.sections) {
          const row: ContextBundleSectionDto = {
            id: newBundleSectionId(),
            sourceId: source.id,
            title: section.title,
            body: section.body,
            tokens: section.tokens,
            fingerprint: section.fingerprint,
          };
          sections.push(row);
          totalTokens += section.tokens;
          fingerprints[source.id] = section.fingerprint;
        }
        sourceRows.push({
          id: source.id,
          params: source.params,
          tokens: result.sections.reduce((n, s) => n + s.tokens, 0),
          fingerprint: result.sections.map((s) => s.fingerprint).join("|") || "",
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        });
      }

      const markdown = renderBundleMarkdown(sections, input.instruction);
      const bundle: ContextBundleDto = {
        id: randomUUID(),
        projectId: input.projectId,
        sessionId: input.sessionId,
        presetId: input.presetId,
        label: input.label,
        instruction: input.instruction,
        sections,
        sources: sourceRows,
        markdown,
        tokens: totalTokens,
        createdAt: now(),
        fingerprints,
        ...(omissions.length ? { omissions } : {}),
      };

      if (totalTokens > (input.warnTokenThreshold ?? opts.warnTokenThreshold)) {
        const ranked = sourceRows
          .filter((s) => s.tokens > 0)
          .map((s) => ({
            id: s.id,
            label: opts.registry.get(s.id)?.label ?? s.id,
            tokens: s.tokens,
          }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5);
        bundle.warning = { tokens: totalTokens, largestSources: ranked };
      }

      const key = bundleKey(input.collectCtx.space.spaceId, bundle.id);
      memoryBundles.set(key, bundle);
      memoryMeta.set(key, {
        id: bundle.id,
        projectId: input.projectId,
        sessionId: input.sessionId,
        presetId: input.presetId,
        label: input.label,
        fingerprints: bundle.fingerprints,
        sourceIds: input.sources.map((s) => s.id),
        createdAt: bundle.createdAt,
        createdBy: input.createdBy,
      });
      pruneBundles(input.collectCtx.space.spaceId);
      return bundle;
    },

    async getBundle(
      _storage: SpaceStorage,
      projectId: string,
      id: string,
      spaceId: string,
      viewer: BundleViewer,
    ): Promise<ContextBundleDto | null> {
      pruneBundles(spaceId);
      const key = bundleKey(spaceId, id);
      const bundle = memoryBundles.get(key);
      if (!bundle || bundle.projectId !== projectId) return null;
      // Someone else's bundle reads exactly like a missing one.
      return await canSee(memoryMeta.get(key), viewer) ? bundle : null;
    },

    async listBundles(
      _storage: SpaceStorage,
      projectId: string,
      spaceId: string,
      viewer: BundleViewer,
    ): Promise<BundleMetadata[]> {
      pruneBundles(spaceId);
      const listed: BundleMetadata[] = [];
      for (const [key, meta] of memoryMeta) {
        if (!key.startsWith(`${spaceId}:`) || meta.projectId !== projectId || !memoryBundles.has(key)) continue;
        if (!await canSee(meta, viewer)) continue;
        const { createdBy: _owner, ...visible } = meta;
        listed.push(visible);
      }
      return listed;
    },

    async checkStale(
      _storage: SpaceStorage,
      collectCtx: ContextCollectInput,
      projectId: string,
      id: string,
      viewer: BundleViewer,
    ) {
      pruneBundles(collectCtx.space.spaceId);
      const key = bundleKey(collectCtx.space.spaceId, id);
      const bundle = memoryBundles.get(key);
      if (!bundle || bundle.projectId !== projectId || !await canSee(memoryMeta.get(key), viewer)) {
        throw err("not-found", `bundle ${id} not found`);
      }
      const staleSources: Array<{ id: string; reason: string }> = [];
      for (const source of bundle.sources) {
        const provider = opts.registry.get(source.id);
        if (!provider) {
          staleSources.push({ id: source.id, reason: "missing" });
          continue;
        }
        const result = await provider.collect({ ...collectCtx, params: source.params });
        const fp = result.sections.map((s) => s.fingerprint).join("|") || "";
        if (result.status === "missing") staleSources.push({ id: source.id, reason: "missing" });
        else if (fp !== source.fingerprint) staleSources.push({ id: source.id, reason: "changed" });
      }
      return { stale: staleSources.length > 0, staleSources };
    },

    estimateSources(
      registry: ContextSourceRegistry,
      collectCtx: ContextCollectInput,
      sources: Array<{ id: string; params?: JsonObject }>,
    ): Promise<Array<{ id: string; label: string; description: string; tokens: number; defaultOn?: boolean }>> {
      return Promise.all(registry.list().map(async (provider) => {
        const selected = sources.find((s) => s.id === provider.id);
        const result = await provider.collect({ ...collectCtx, params: selected?.params });
        const tokens = result.sections.reduce((n, s) => n + s.tokens, 0);
        return {
          id: provider.id,
          label: provider.label,
          description: provider.description,
          tokens,
          ...(provider.defaultOn !== undefined ? { defaultOn: provider.defaultOn } : {}),
        };
      }));
    },
  };
}

export { hashText } from "./hash.ts";
