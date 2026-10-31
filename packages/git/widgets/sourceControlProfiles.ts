import { useSyncExternalStore } from "react";
import {
  SOURCE_CONTROL_AUTH_MODES,
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  parseSourceControlHostingAccountRef,
  resolveSourceControlContext,
  type SourceControlCommitIdentity,
  type SourceControlProfile,
  type SourceControlRemote,
  type SourceControlResolution,
} from "@polyth/contracts/source-control";

export interface SourceControlProfileState {
  profiles: SourceControlProfile[];
  globalDefaultProfileId: string | null;
  repositoryProfileIds: Record<string, string>;
  repositorySystemIdentities: Record<string, SourceControlCommitIdentity>;
}

interface LegacyGitPersona {
  id: string;
  label: string;
  name: string;
  email: string;
}

const KEY = "polyth.sourceControlProfiles.v1";
const LEGACY_KEY = "polyth.gitPersonas.v1";
const listeners = new Set<() => void>();
const EMPTY: SourceControlProfileState = {
  profiles: [],
  globalDefaultProfileId: null,
  repositoryProfileIds: {},
  repositorySystemIdentities: {},
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const parseIdentity = (value: unknown): SourceControlCommitIdentity | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<SourceControlCommitIdentity>;
  const name = text(row.name);
  const email = text(row.email);
  return name && email ? { name, email } : null;
};

const parseMetadata = (value: unknown): Readonly<Record<string, string>> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).flatMap(([key, rawValue]) => {
    const cleanKey = text(key);
    const cleanValue = text(rawValue);
    return cleanKey && cleanValue ? [[cleanKey, cleanValue] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
};

function parseProfile(value: unknown): SourceControlProfile | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<SourceControlProfile>;
  const id = text(row.id);
  const label = text(row.label);
  if (!id || !label) return null;
  const provider = row.provider === "github" || row.provider === "gitlab" ? row.provider : "generic";
  const auth = row.authentication && typeof row.authentication === "object" ? row.authentication : { mode: "system-git" as const };
  const hostingAccount = parseSourceControlHostingAccountRef(row.hostingAccount);
  const declared = SOURCE_CONTROL_AUTH_MODES.find((mode) => mode === auth.mode) ?? "system-git";
  const mode = declared === "account" && !hostingAccount ? "system-git" : declared;
  const commitAuthor = parseIdentity(row.commitAuthor);
  const signingKey = text(row.signingKey);
  const metadata = parseMetadata(row.metadata);
  return {
    id,
    label,
    provider,
    ...(text(row.host) ? { host: text(row.host) } : {}),
    ...(text(row.account) ? { account: text(row.account) } : {}),
    ...(text(row.username) ? { username: text(row.username) } : {}),
    ...(commitAuthor ? { commitAuthor } : {}),
    authentication: {
      mode,
      ...(text(auth.credentialRef) ? { credentialRef: text(auth.credentialRef) } : {}),
      ...(text(auth.accountRef) ? { accountRef: text(auth.accountRef) } : {}),
      ...(mode === "ssh-key" && text(auth.identityFile) ? { identityFile: text(auth.identityFile) } : {}),
    },
    ...(signingKey ? { signingKey } : {}),
    ...(hostingAccount ? { hostingAccount } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseLegacy(raw: string | null): SourceControlProfile[] {
  try {
    const rows = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((value) => {
      const row = value as Partial<LegacyGitPersona>;
      const id = text(row.id);
      const label = text(row.label);
      const name = text(row.name);
      const email = text(row.email);
      if (!id || !label || !name || !email) return [];
      return [{
        id,
        label,
        provider: "generic" as const,
        commitAuthor: { name, email },
        authentication: { mode: "system-git" as const },
      }];
    });
  } catch {
    return [];
  }
}

export function parseSourceControlProfileState(raw: string | null, legacyRaw: string | null = null): SourceControlProfileState {
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<SourceControlProfileState> | null;
    if (parsed && typeof parsed === "object") {
      const profiles = Array.isArray(parsed.profiles) ? parsed.profiles.flatMap((row) => {
        const profile = parseProfile(row);
        return profile ? [profile] : [];
      }) : [];
      const validIds = new Set(profiles.map((profile) => profile.id));
      const repositoryProfileIds = parsed.repositoryProfileIds && typeof parsed.repositoryProfileIds === "object"
        ? Object.fromEntries(Object.entries(parsed.repositoryProfileIds).filter(([projectId, profileId]) =>
            !!text(projectId) && typeof profileId === "string" && (profileId === SYSTEM_SOURCE_CONTROL_PROFILE_ID || validIds.has(profileId))))
        : {};
      const repositorySystemIdentities = parsed.repositorySystemIdentities && typeof parsed.repositorySystemIdentities === "object"
        ? Object.fromEntries(Object.entries(parsed.repositorySystemIdentities).flatMap(([projectId, identity]) => {
            const parsedIdentity = parseIdentity(identity);
            return text(projectId) && parsedIdentity ? [[projectId, parsedIdentity]] : [];
          }))
        : {};
      const globalDefaultProfileId = typeof parsed.globalDefaultProfileId === "string"
        && (parsed.globalDefaultProfileId === SYSTEM_SOURCE_CONTROL_PROFILE_ID || validIds.has(parsed.globalDefaultProfileId))
        ? parsed.globalDefaultProfileId
        : null;
      return { profiles, globalDefaultProfileId, repositoryProfileIds, repositorySystemIdentities };
    }
  } catch {
    // Fall through to deterministic legacy migration.
  }
  const profiles = parseLegacy(legacyRaw);
  return { profiles, globalDefaultProfileId: null, repositoryProfileIds: {}, repositorySystemIdentities: {} };
}

function read(): SourceControlProfileState {
  try {
    const raw = localStorage.getItem(KEY);
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    const next = parseSourceControlProfileState(raw, legacyRaw);
    if (!raw && next.profiles.length > 0) {
      localStorage.setItem(KEY, JSON.stringify(next));
      localStorage.removeItem(LEGACY_KEY);
    }
    return next;
  } catch {
    return { ...EMPTY, repositoryProfileIds: {}, repositorySystemIdentities: {} };
  }
}

let state = read();
let base: { state: SourceControlProfileState; revision: number } | null = null;
let queue: Promise<void> = Promise.resolve();
let pending = 0;

export interface SourceControlProfileTransport {
  load(): Promise<{ state: SourceControlProfileState; revision: number }>;
  save(state: SourceControlProfileState, expectedRevision: number): Promise<{ state: SourceControlProfileState; revision: number }>;
}
let transport: SourceControlProfileTransport = {
  load: async () => (await import("@polyth/session/web-api")).api.gitSourceControlProfiles(),
  save: async (next, rev) => (await import("@polyth/session/web-api")).api.gitSourceControlProfilesSave(next, rev),
};
export function setSourceControlProfileTransport(next: SourceControlProfileTransport): void {
  transport = next;
  base = null;
}

const normalize = (value: unknown): SourceControlProfileState => parseSourceControlProfileState(JSON.stringify(value), "");
const hasData = (s: SourceControlProfileState): boolean => s.profiles.length > 0;

/** Local cache update without a server write (server pushes, storage events). */
function adopt(next: SourceControlProfileState): void {
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* best effort */ }
  for (const listener of [...listeners]) listener();
}

async function fetchServer(): Promise<{ state: SourceControlProfileState; revision: number }> {
  let snap = await transport.load();
  // One-time migration: an empty server adopts this device's cached profiles.
  if (snap.revision === 0 && !hasData(normalize(snap.state)) && hasData(state)) {
    try { snap = await transport.save(state, 0); } catch { snap = await transport.load(); }
  }
  return base = { state: normalize(snap.state), revision: snap.revision };
}

const isConflict = (e: unknown): boolean => (e as { status?: number })?.status === 409;

async function persist(mutate: (s: SourceControlProfileState) => SourceControlProfileState): Promise<void> {
  try {
    let snap = base ?? await fetchServer();
    for (let attempt = 0; ; attempt++) {
      try {
        const saved = await transport.save(mutate(snap.state), snap.revision);
        base = { state: normalize(saved.state), revision: saved.revision };
        if (pending === 1) adopt(base.state);
        return;
      } catch (e) {
        if (!isConflict(e) || attempt) throw e;
        snap = await fetchServer();
      }
    }
  } catch {
    base = null; // offline/failed: keep the optimistic cache, resync on next focus
  }
}

function publish(mutate: (s: SourceControlProfileState) => SourceControlProfileState): void {
  adopt(mutate(state));
  pending++;
  queue = queue.then(() => persist(mutate)).finally(() => { pending--; });
}

/** Pull the server state (focus/visibility); skipped while local writes are in flight. */
export async function refreshSourceControlProfiles(): Promise<void> {
  try {
    const snap = await fetchServer();
    if (pending === 0) adopt(snap.state);
  } catch { base = null; }
}

export function getSourceControlProfileState(): SourceControlProfileState {
  return state;
}

export function replaceSourceControlProfileState(value: unknown): void {
  const next = normalize(value);
  publish(() => next);
}

export function subscribeSourceControlProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSourceControlProfileState(): SourceControlProfileState {
  return useSyncExternalStore(
    subscribeSourceControlProfiles,
    getSourceControlProfileState,
    getSourceControlProfileState,
  );
}

export function saveSourceControlProfile(profile: SourceControlProfile): void {
  const normalized = parseProfile(profile);
  if (!normalized) return;
  publish((s) => ({ ...s, profiles: [...s.profiles.filter((row) => row.id !== normalized.id), normalized] }));
}

export function removeSourceControlProfile(id: string): void {
  publish((s) => ({
    ...s,
    profiles: s.profiles.filter((row) => row.id !== id),
    globalDefaultProfileId: s.globalDefaultProfileId === id ? null : s.globalDefaultProfileId,
    repositoryProfileIds: Object.fromEntries(Object.entries(s.repositoryProfileIds).filter(([, profileId]) => profileId !== id)),
  }));
}

export function setGlobalSourceControlProfile(id: string | null): void {
  publish((s) => ({ ...s, globalDefaultProfileId: id }));
}

export function setRepositorySourceControlProfile(projectId: string, id: string | null): void {
  publish((s) => {
    const repositoryProfileIds = { ...s.repositoryProfileIds };
    if (id) repositoryProfileIds[projectId] = id;
    else delete repositoryProfileIds[projectId];
    return { ...s, repositoryProfileIds };
  });
}

export function rememberRepositorySystemIdentity(projectId: string, identity: SourceControlCommitIdentity): void {
  if (state.repositorySystemIdentities[projectId]) return;
  publish((s) => s.repositorySystemIdentities[projectId] ? s
    : { ...s, repositorySystemIdentities: { ...s.repositorySystemIdentities, [projectId]: identity } });
}

export function consumeRepositorySystemIdentity(projectId: string): SourceControlCommitIdentity | null {
  const identity = state.repositorySystemIdentities[projectId] ?? null;
  if (!identity) return null;
  publish((s) => {
    const repositorySystemIdentities = { ...s.repositorySystemIdentities };
    delete repositorySystemIdentities[projectId];
    return { ...s, repositorySystemIdentities };
  });
  return identity;
}

export function resolveStoredSourceControlContext(input: {
  projectId: string;
  remote?: SourceControlRemote | null;
  projectProfileId?: string | null;
  systemIdentity?: SourceControlCommitIdentity | null;
}): SourceControlResolution {
  return resolveSourceControlContext({
    profiles: state.profiles,
    remote: input.remote,
    repositoryProfileId: state.repositoryProfileIds[input.projectId],
    projectProfileId: input.projectProfileId,
    globalProfileId: state.globalDefaultProfileId,
    systemIdentity: input.systemIdentity,
  });
}

export function applyProfileCommitIdentity(
  profile: SourceControlProfile | null,
  systemIdentity: SourceControlCommitIdentity,
): SourceControlCommitIdentity {
  return profile?.commitAuthor ?? systemIdentity;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === LEGACY_KEY) adopt(read());
  });
  const resync = () => { if (document.visibilityState !== "hidden") void refreshSourceControlProfiles(); };
  window.addEventListener("focus", resync);
  document.addEventListener("visibilitychange", resync);
  resync();
}
