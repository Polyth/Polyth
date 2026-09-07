import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type {
  SecureSafeCreateInput,
  SecureSafeEntryDto,
  SecureSafeKind,
  SecureSafeManifest,
  SecureSafePatchInput,
  SecureSafeScope,
  SecureSafeService,
} from "@polyth/contracts";

export interface SecureSafeOptions {
  dataDir: string;
  /** Called after a mutation has regenerated the handle-only manifest. */
  onChanged?(): Promise<void>;
}

const error = (code: string, message: string) => Object.assign(new Error(message), { code });

function load<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const envRefFor = (handle: string): string =>
  `POLYTH_SAFE_${handle.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

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
      envRef: envRefFor(handle),
    })),
  };
}

export function secureSafeBehaviorSection(manifestPath: string, manifest: SecureSafeManifest): string {
  return [
    "## Secure Safe",
    "",
    `Available credential handles are listed in \`${manifestPath}\`. This manifest contains handles only, never secret values.`,
    "To request that a user save a secret, use AskUserQuestion with question metadata",
    '`{ "secureSafe": true, "handle": "HANDLE", "label": "Human label", "purpose": "Why it is needed", "kind": "env|token|password" }`.',
    "Never ask a user to paste secrets in chat. Always use Secure Safe.",
    "",
    "Current forbidden config (values are intentionally absent):",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
  ].join("\n");
}

const OPAQUE_KEY = /^[A-Za-z0-9:._-]{8,240}$/;

function opaqueName(key: string): string {
  if (!OPAQUE_KEY.test(key)) throw error("invalid-input", "opaque key is invalid");
  return `opaque:${key}`;
}

export function createSecureSafeService(opts: SecureSafeOptions): SecureSafeService {
  mkdirSync(opts.dataDir, { recursive: true });
  const metadataFile = join(opts.dataDir, "secure-safe.json");
  const secretsFile = join(opts.dataDir, "secure-safe-secrets.json");
  const manifestFile = join(opts.dataDir, "forbidden-config.json");

  let entries = load<SecureSafeEntryDto[]>(metadataFile, []);
  let secrets = load<Record<string, string>>(secretsFile, {});

  const ensureUnique = (handle: string, exceptId?: string): void => {
    const key = handle.toLocaleLowerCase();
    const envRef = envRefFor(handle);
    if (entries.some((entry) =>
      entry.id !== exceptId
      && (entry.handle.toLocaleLowerCase() === key || envRefFor(entry.handle) === envRef)
    )) {
      throw error("conflict", `a Secure Safe entry with handle "${handle}" already exists`);
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
    if (!row) throw error("not-found", "Secure Safe entry not found");
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

  return {
    redact(text) {
      for (const value of Object.values(secrets).filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(value).join("[redacted]");
      return text;
    },
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
}
