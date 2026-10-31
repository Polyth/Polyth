import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync, collapseRepeatedPackageNamespace, isPackageOpaqueKey, legacyOpaqueOwner, packageOpaqueKey } from "@polyth/plugins";
import type {
  SecureSafeCreateInput,
  SecureSafeCredentialUseRequest,
  SecureSafeEntryDto,
  SecureSafeExecutionEnv,
  SecureSafeExecutionRequest,
  SecureSafeKind,
  SecureSafeManifest,
  SecureSafePartition,
  SecureSafePatchInput,
  SecureSafeScope,
  SecureSafeService,
  SpaceContext,
} from "@polyth/contracts";

export interface SecureSafeOptions {
  dataDir: string;
  /** Called after a mutation has regenerated the handle-only manifest. */
  onChanged?(): Promise<void>;
  /** Called after a successful server-side resolution with handle metadata
   * only. The callback must never receive or derive a secret value. */
  onResolved?(info: {
    space?: SpaceContext;
    projectId: string;
    handles: readonly string[];
  }): void;
  /** Build a physical Space/host store, bypassing process-level Space routing. */
  localOnly?: boolean;
  /**
   * A Space store's view of one person's own store: undefined unless `userId`
   * is a person who is an active member of this Space. With it, a request
   * naming `actorUserId` resolves that person's entries before the Space's.
   */
  personal?(userId: string): SecureSafeService | undefined;
  /**
   * Move opaque keys written before package namespaces (`google:…`) under
   * their owner's namespace (`pkg.google:google:…`) on open. Default: on for
   * the routed host store, off for local stores (Space stores opt in; person
   * and provider stores are already partitioned and never namespaced).
   */
  migrateLegacyOpaque?: boolean;
}

const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const spaceContext = new AsyncLocalStorage<SpaceContext>();
let spaceResolver: ((ctx: SpaceContext) => SecureSafeService | undefined) | null = null;
let personResolver: ((ctx: SpaceContext, userId: string) => SecureSafeService | undefined) | null = null;
const physicalSafes = new Set<SecureSafeService>();

/** Bind process-local Space storage. The resolver receives only a server-issued
 * SpaceContext; request payloads can never select a secret store directly. */
export function configureSecureSafeSpaceRouting(
  resolver: (ctx: SpaceContext) => SecureSafeService | undefined,
): void {
  spaceResolver = resolver;
}

/** Bind person-owned stores. The resolver receives a server-issued
 * SpaceContext and must return a store only for an active member of it. */
export function configureSecureSafePersonRouting(
  resolver: (ctx: SpaceContext, userId: string) => SecureSafeService | undefined,
): void {
  personResolver = resolver;
}

/**
 * Where a saved Secure Safe request lands (Spaces §14.4). A person's own
 * partition unless an admin explicitly picks the Space; a non-admin asking
 * for the Space is refused rather than silently downgraded. With no
 * explicit pick an admin's private chat still saves privately, an admin's
 * shared chat keeps the Space default. No person (system work): Space.
 */
export function secretSavePartition(input: {
  requested?: SecureSafePartition | undefined;
  person?: string | undefined;
  spaceAdmin: boolean;
  privateChat: boolean;
}): SecureSafePartition {
  if (input.requested !== undefined && input.requested !== "space" && input.requested !== "personal") {
    throw error("invalid-input", "partition must be personal or space");
  }
  if (!input.person) {
    if (input.requested === "personal") throw error("invalid-input", "only a person can save a personal credential");
    return "space";
  }
  if (input.requested === "space") {
    if (!input.spaceAdmin) {
      throw Object.assign(error("forbidden", "Only Space admins can save Space credentials"), { mutationOutcome: "not-started" });
    }
    return "space";
  }
  if (input.requested === "personal" || input.privateChat || !input.spaceAdmin) return "personal";
  return "space";
}

/** Carry the already-authorized Space across one scoped service operation. */
export function runWithSecureSafeSpace<T>(ctx: SpaceContext, action: () => T): T {
  return spaceContext.run(ctx, action);
}

function load<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export const secureSafeEnvRef = (handle: string): string =>
  `POLYTH_SAFE_${handle.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

const ENV_REF = /^POLYTH_SAFE_[A-Z][A-Z0-9_]*$/;

/** Extract only reserved Credential Vault references from a command or script
 * fragment. Values are never read here; this only discovers names. */
export function extractSecureSafeEnvRefs(text: string): string[] {
  const refs = new Set<string>();
  const pattern = /\b(POLYTH_SAFE_[A-Z][A-Z0-9_]*)\b/g;
  for (const match of text.matchAll(pattern)) refs.add(match[1]!);
  return [...refs];
}

const requiredText = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string") throw error("invalid-input", `${field} must be a string`);
  const text = value.trim();
  if (!text) throw error("invalid-input", `${field} is required`);
  if (text.length > max) throw error("invalid-input", `${field} must be at most ${max} characters`);
  return text;
};

const optionalText = (value: unknown, field: string, max: number): string => {
  if (value === undefined) return "";
  if (typeof value !== "string") throw error("invalid-input", `${field} must be a string`);
  const text = value.trim();
  if (text.length > max) throw error("invalid-input", `${field} must be at most ${max} characters`);
  return text;
};

const validKind = (value: unknown): value is SecureSafeKind =>
  value === "env" || value === "token" || value === "password";

const validScope = (value: unknown): value is SecureSafeScope =>
  value === "global" || value === "project";

function normalizeHandle(value: unknown): string {
  const handle = requiredText(value, "handle", 64);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(handle)) {
    throw error("invalid-input", "handle must start with a letter and contain only letters, numbers, '.', '_', or '-'");
  }
  return handle;
}

function manifestFor(entries: SecureSafeEntryDto[]): SecureSafeManifest {
  return {
    version: 1,
    handles: entries.map(({ handle, label, purpose, kind }) => ({
      handle,
      label,
      purpose,
      kind,
      envRef: secureSafeEnvRef(handle),
    })),
  };
}

export function secureSafeBehaviorSection(_manifestPath: string, _manifest: SecureSafeManifest): string {
  return [
    "## Credential boundary",
    "",
    "Credential Vault is relevant only when the current task needs a stored credential, secret-backed authentication, a secret-backed browser fill, or a handle lookup. For unrelated tasks, do not call Credential Vault tools, inspect manifests, or mention this capability.",
    "When it is relevant, use the `polyth-secure-safe` skill and its server-authorized handle workflow. Never request, accept, echo, print, log, or summarize a plaintext secret in chat.",
  ].join("\n");
}

export { SECURE_SAFE_PACKAGE_ID, secureSafeSkill } from "./agentSkill.ts";

// Package facades add `pkg.<packageId>:` (≤ 69 chars) to a key of ≤ 240.
const OPAQUE_KEY = /^[A-Za-z0-9:._-]{8,320}$/;

function opaqueName(key: string): string {
  if (!OPAQUE_KEY.test(key)) throw error("invalid-input", "opaque key is invalid");
  return `opaque:${key}`;
}

/**
 * Move pre-namespace opaque keys under their owning package's namespace, so
 * the package-bound facade (`pkg.<id>:<key>`) finds them, and collapse a
 * repeated namespace (`pkg.<id>:pkg.<id>:<key>`) to one. Idempotent: a moved
 * key is namespaced, and an existing namespaced value is never overwritten by
 * a legacy one.
 * Keys no package claims stay where they are (host-only) and are reported
 * once, by count only. Returns whether anything moved.
 */
function migrateLegacyOpaque(secrets: Record<string, string>, dataDir: string): boolean {
  let moved = 0;
  let unclaimed = 0;
  for (const name of Object.keys(secrets)) {
    if (!name.startsWith("opaque:")) continue;
    const key = name.slice("opaque:".length);
    if (isPackageOpaqueKey(key)) {
      // A repeated namespace came from the doubly bound host, so it is newer
      // than a single-namespace value migrated from a legacy key.
      const collapsed = collapseRepeatedPackageNamespace(key);
      if (collapsed === key) continue;
      secrets[`opaque:${collapsed}`] = secrets[name]!;
      delete secrets[name];
      moved += 1;
      continue;
    }
    const owner = legacyOpaqueOwner(key);
    if (!owner) {
      unclaimed += 1;
      continue;
    }
    const target = `opaque:${packageOpaqueKey(owner, key)}`;
    if (secrets[target] === undefined) secrets[target] = secrets[name]!;
    delete secrets[name];
    moved += 1;
  }
  if (unclaimed > 0) {
    console.warn(`[credential-vault] ${unclaimed} opaque key(s) in ${dataDir} belong to no known package; they stay readable only by the host`);
  }
  return moved > 0;
}

/** Forget a physical store whose files were deleted (a removed person's
 * partition), so background redaction stops holding its values in memory. */
export function releaseSecureSafeService(safe: SecureSafeService): void {
  physicalSafes.delete(safe);
}

export function createSecureSafeService(opts: SecureSafeOptions): SecureSafeService {
  mkdirSync(opts.dataDir, { recursive: true });
  const metadataFile = join(opts.dataDir, "secure-safe.json");
  const secretsFile = join(opts.dataDir, "secure-safe-secrets.json");
  const manifestFile = join(opts.dataDir, "forbidden-config.json");

  let entries = load<SecureSafeEntryDto[]>(metadataFile, []);
  let secrets = load<Record<string, string>>(secretsFile, {});
  if ((opts.migrateLegacyOpaque ?? !opts.localOnly) && migrateLegacyOpaque(secrets, opts.dataDir)) {
    atomicWriteSync(secretsFile, JSON.stringify(secrets), 0o600);
  }

  const ensureUnique = (handle: string, exceptId?: string): void => {
    const key = handle.toLocaleLowerCase();
    const envRef = secureSafeEnvRef(handle);
    if (entries.some((entry) =>
      entry.id !== exceptId
      && (entry.handle.toLocaleLowerCase() === key || secureSafeEnvRef(entry.handle) === envRef)
    )) {
      throw error("conflict", `a Credential Vault entry with handle "${handle}" already exists`);
    }
  };

  const persistSecrets = (): void => {
    atomicWriteSync(secretsFile, JSON.stringify(secrets), 0o600);
  };

  const persist = (): SecureSafeManifest => {
    const manifest = manifestFor(entries);
    atomicWriteSync(metadataFile, JSON.stringify(entries, null, 2));
    persistSecrets();
    atomicWriteSync(manifestFile, JSON.stringify(manifest, null, 2));
    return manifest;
  };

  const changed = async (): Promise<void> => {
    persist();
    await opts.onChanged?.();
  };

  const create = async (input: SecureSafeCreateInput): Promise<SecureSafeEntryDto> => {
    const handle = normalizeHandle(input.handle);
    const label = requiredText(input.label, "label", 128);
    const purpose = optionalText(input.purpose, "purpose", 500);
    const kind = input.kind ?? "token";
    const scope = input.scope ?? "global";
    if (!validKind(kind)) throw error("invalid-input", "kind must be env, token, or password");
    if (!validScope(scope)) throw error("invalid-input", "scope must be global or project");
    const projectId = scope === "project" ? requiredText(input.projectId, "projectId", 200) : undefined;
    if (typeof input.value !== "string" || !input.value.trim()) {
      throw error("invalid-input", "value is required");
    }
    ensureUnique(handle);
    const now = Date.now();
    const row: SecureSafeEntryDto = {
      id: randomUUID(),
      handle,
      label,
      purpose,
      kind,
      scope,
      ...(projectId ? { projectId } : {}),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    entries.push(row);
    secrets[row.id] = input.value;
    await changed();
    return { ...row };
  };

  const update = async (id: string, patch: SecureSafePatchInput): Promise<SecureSafeEntryDto> => {
    const row = entries.find((entry) => entry.id === id);
    if (!row) throw error("not-found", "Credential Vault entry not found");
    const handle = patch.handle === undefined ? row.handle : normalizeHandle(patch.handle);
    ensureUnique(handle, id);
    const label = patch.label === undefined ? row.label : requiredText(patch.label, "label", 128);
    const purpose = patch.purpose === undefined ? row.purpose : optionalText(patch.purpose, "purpose", 500);
    const kind = patch.kind ?? row.kind;
    const scope = patch.scope ?? row.scope;
    if (!validKind(kind)) throw error("invalid-input", "kind must be env, token, or password");
    if (!validScope(scope)) throw error("invalid-input", "scope must be global or project");
    const requestedProject = patch.projectId === null ? undefined : patch.projectId;
    const projectId = scope === "project"
      ? requiredText(requestedProject ?? row.projectId, "projectId", 200)
      : undefined;

    row.handle = handle;
    row.label = label;
    row.purpose = purpose;
    row.kind = kind;
    row.scope = scope;
    if (projectId) row.projectId = projectId;
    else delete row.projectId;
    if (typeof patch.value === "string" && patch.value.trim()) secrets[id] = patch.value;
    row.revision += 1;
    row.updatedAt = Date.now();
    await changed();
    return { ...row };
  };

  const resolveCredential = (input: SecureSafeCredentialUseRequest): { handle: string; value: string } => {
    if (!input || typeof input.projectId !== "string" || !input.projectId.trim()) {
      throw error("invalid-input", "projectId is required");
    }
    const handle = normalizeHandle(input.handle);
    const entry = entries.find((candidate) =>
      candidate.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());
    // A project mismatch is deliberately indistinguishable from a missing
    // handle so this broker cannot become a cross-project existence oracle.
    if (!entry || (entry.scope === "project" && entry.projectId !== input.projectId)) {
      throw error("not-found", "Credential Vault handle not found");
    }
    const value = secrets[entry.id];
    if (typeof value !== "string" || !value) {
      throw error("unavailable", "Credential Vault value is unavailable");
    }
    return { handle: entry.handle, value };
  };

  // The acting person's own store, when this Space store knows its members.
  const personalFor = (actorUserId: unknown): SecureSafeService | undefined => {
    if (!opts.personal || typeof actorUserId !== "string" || !actorUserId) return undefined;
    try {
      return opts.personal(actorUserId);
    } catch {
      return undefined;
    }
  };
  const missing = (cause: unknown): boolean => (cause as { code?: unknown } | null)?.code === "not-found";

  const useCredential = async (
    input: SecureSafeCredentialUseRequest,
    use: (value: string) => void | Promise<void>,
  ): Promise<void> => {
    if (typeof use !== "function") throw error("invalid-input", "credential callback is required");
    const personal = personalFor(input?.actorUserId);
    if (personal?.useCredential) {
      // Personal first. Only "no such handle" falls through to the Space;
      // a personal entry without a value never borrows the Space's, and a
      // failure inside the callback is never retried with another value.
      let entered = false;
      try {
        await personal.useCredential({ projectId: input.projectId, handle: input.handle }, (value) => {
          entered = true;
          return use(value);
        });
        return;
      } catch (cause) {
        if (entered || !missing(cause)) throw cause;
      }
    }
    const resolved = resolveCredential(input);
    if (opts.localOnly) {
      opts.onResolved?.({
        ...(spaceContext.getStore() ? { space: spaceContext.getStore() } : {}),
        projectId: input.projectId,
        handles: [resolved.handle],
      });
    }
    await use(resolved.value);
  };

  const resolveExecutionEnv = (input: SecureSafeExecutionRequest): SecureSafeExecutionEnv => {
    if (!input || typeof input.projectId !== "string" || !input.projectId.trim()) {
      throw error("invalid-input", "projectId is required");
    }
    if (!Array.isArray(input.envRefs)) {
      throw error("invalid-input", "envRefs must be an array");
    }
    const refs = [...new Set(input.envRefs)];
    if (refs.length > 64) throw error("invalid-input", "too many Credential Vault references");
    const personal = personalFor(input.actorUserId);
    const env: Record<string, string> = {};
    const handles: string[] = [];
    for (const ref of refs) {
      if (typeof ref !== "string" || !ENV_REF.test(ref)) {
        throw error("invalid-input", "Credential Vault env reference is invalid");
      }
      if (personal?.resolveExecutionEnv) {
        try {
          const own = personal.resolveExecutionEnv({ projectId: input.projectId, envRefs: [ref] });
          env[ref] = own.env[ref]!;
          handles.push(...own.handles);
          continue;
        } catch (cause) {
          if (!missing(cause)) throw cause;
        }
      }
      const entry = entries.find((candidate) => secureSafeEnvRef(candidate.handle) === ref);
      // A project mismatch is deliberately indistinguishable from a missing
      // handle so the resolver cannot become a cross-project existence oracle.
      if (!entry || (entry.scope === "project" && entry.projectId !== input.projectId)) {
        throw error("not-found", "Credential Vault handle not found");
      }
      const value = secrets[entry.id];
      if (typeof value !== "string" || !value) {
        throw error("unavailable", "Credential Vault value is unavailable");
      }
      env[ref] = value;
      handles.push(entry.handle);
    }
    return { env, handles };
  };

  const physical: SecureSafeService = {
    redact(text) {
      for (const value of Object.values(secrets).filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(value).join("[redacted]");
      return text;
    },
    resolveExecutionEnv(input) {
      const resolved = resolveExecutionEnv(input);
      if (opts.localOnly && resolved.handles.length > 0) {
        opts.onResolved?.({
          ...(spaceContext.getStore() ? { space: spaceContext.getStore() } : {}),
          projectId: input.projectId,
          handles: resolved.handles,
        });
      }
      return resolved;
    },
    useCredential,
    list: () => entries.map((entry) => ({ ...entry })),
    manifest: () => manifestFor(entries),
    hasHandle: (handle) => entries.some((entry) => entry.handle.toLocaleLowerCase() === handle.trim().toLocaleLowerCase()),
    create,
    update,
    async remove(id): Promise<boolean> {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      delete secrets[id];
      await changed();
      return true;
    },
    async upsertByHandle(input): Promise<SecureSafeEntryDto> {
      const handle = normalizeHandle(input.handle);
      const row = entries.find((entry) => entry.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());
      if (!row) return create({ ...input, handle });
      return update(row.id, {
        label: input.label,
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        value: input.value,
      });
    },
    async syncForbiddenConfig(): Promise<SecureSafeManifest> {
      const manifest = manifestFor(entries);
      atomicWriteSync(manifestFile, JSON.stringify(manifest, null, 2));
      return manifest;
    },
    putOpaque(key, value) {
      const opaqueKey = opaqueName(key);
      if (typeof value !== "string" || !value) throw error("invalid-input", "opaque value is required");
      secrets[opaqueKey] = value;
      persistSecrets();
    },
    getOpaque(key) {
      return secrets[opaqueName(key)] ?? null;
    },
    deleteOpaque(key) {
      delete secrets[opaqueName(key)];
      persistSecrets();
    },
    deleteOpaqueByPrefix(prefix) {
      const needle = `opaque:${prefix}`;
      for (const key of Object.keys(secrets)) {
        if (key.startsWith(needle)) delete secrets[key];
      }
      persistSecrets();
    },
  };
  physicalSafes.add(physical);
  if (opts.localOnly) return physical;

  const selected = (): SecureSafeService => {
    const ctx = spaceContext.getStore();
    if (!ctx) return physical;
    const safe = spaceResolver?.(ctx);
    if (!safe) throw error("HOST_UNAVAILABLE", "Space-owned Credential Vault is unavailable");
    return safe;
  };

  const personOf = (ctx: SpaceContext, userId: string): SecureSafeService | undefined => {
    try {
      return personResolver?.(ctx, userId);
    } catch {
      return undefined;
    }
  };

  return {
    redact(text) {
      const ctx = spaceContext.getStore();
      if (ctx) {
        // The Space's values and the signed-in person's own: the person
        // whose personal entries a scoped shell run can have resolved.
        const own = ctx.userId ? personOf(ctx, ctx.userId) : undefined;
        const spaceRedacted = selected().redact?.(text) ?? text;
        return own?.redact?.(spaceRedacted) ?? spaceRedacted;
      }
      // Background continuity/log sanitizers may run outside the originating
      // request async resource. Over-redaction across already-open physical
      // safes is safe; selecting another Space for writes/reads is not.
      for (const safe of physicalSafes) text = safe.redact?.(text) ?? text;
      return text;
    },
    resolveExecutionEnv(input) {
      const safe = selected();
      const resolved = safe.resolveExecutionEnv?.(input);
      if (!resolved) throw error("unsupported", "Credential Vault execution resolver is unavailable");
      const ctx = spaceContext.getStore();
      if (resolved.handles.length > 0) {
        opts.onResolved?.({
          ...(ctx ? { space: ctx } : {}),
          projectId: input.projectId,
          handles: resolved.handles,
        });
      }
      return resolved;
    },
    async useCredential(input, use) {
      const safe = selected();
      if (!safe.useCredential) {
        throw error("unsupported", "Credential Vault credential broker is unavailable");
      }
      await safe.useCredential(input, use);
      const ctx = spaceContext.getStore();
      opts.onResolved?.({
        ...(ctx ? { space: ctx } : {}),
        projectId: input.projectId,
        handles: [input.handle],
      });
    },
    forPerson(userId) {
      const ctx = spaceContext.getStore();
      return ctx ? personOf(ctx, userId) : undefined;
    },
    list: () => selected().list(),
    listFor(actorUserId) {
      const ctx = spaceContext.getStore();
      const personal = ctx && actorUserId ? personOf(ctx, actorUserId) : undefined;
      return [
        ...(personal?.list() ?? []).map((entry) => ({ ...entry, partition: "personal" as const })),
        ...selected().list().map((entry) => ({ ...entry, partition: "space" as const })),
      ];
    },
    manifest: () => selected().manifest(),
    hasHandle(handle) {
      // Never reveal that a handle exists in another Space when the runtime
      // callback lacks a trusted Space context.
      if (!spaceContext.getStore()) return physical.hasHandle(handle);
      return selected().hasHandle(handle);
    },
    create: (input) => selected().create(input),
    update: (id, patch) => selected().update(id, patch),
    remove: (id) => selected().remove(id),
    upsertByHandle: (input) => selected().upsertByHandle(input),
    syncForbiddenConfig: () => selected().syncForbiddenConfig(),
    putOpaque: (key, value) => selected().putOpaque(key, value),
    getOpaque: (key) => selected().getOpaque(key),
    deleteOpaque: (key) => selected().deleteOpaque(key),
    deleteOpaqueByPrefix: (prefix) => selected().deleteOpaqueByPrefix(prefix),
  };
}
