import { useSyncExternalStore } from "react";
import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
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
  const mode = auth.mode === "ssh-agent" || auth.mode === "credential-helper" || auth.mode === "provider-cli" || auth.mode === "managed"
    ? auth.mode
    : "system-git";
  const commitAuthor = parseIdentity(row.commitAuthor);
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
    },
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

function publish(next: SourceControlProfileState): void {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* best effort */ }
  for (const listener of [...listeners]) listener();
}

export function getSourceControlProfileState(): SourceControlProfileState {
  return state;
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
  publish({ ...state, profiles: [...state.profiles.filter((row) => row.id !== normalized.id), normalized] });
}

export function removeSourceControlProfile(id: string): void {
  const repositoryProfileIds = Object.fromEntries(
    Object.entries(state.repositoryProfileIds).filter(([, profileId]) => profileId !== id),
  );
  publish({
    ...state,
    profiles: state.profiles.filter((row) => row.id !== id),
    globalDefaultProfileId: state.globalDefaultProfileId === id ? null : state.globalDefaultProfileId,
    repositoryProfileIds,
  });
}

export function setGlobalSourceControlProfile(id: string | null): void {
  publish({ ...state, globalDefaultProfileId: id });
}

export function setRepositorySourceControlProfile(projectId: string, id: string | null): void {
  const repositoryProfileIds = { ...state.repositoryProfileIds };
  if (id) repositoryProfileIds[projectId] = id;
  else delete repositoryProfileIds[projectId];
  publish({ ...state, repositoryProfileIds });
}

export function rememberRepositorySystemIdentity(projectId: string, identity: SourceControlCommitIdentity): void {
  if (state.repositorySystemIdentities[projectId]) return;
  publish({
    ...state,
    repositorySystemIdentities: { ...state.repositorySystemIdentities, [projectId]: identity },
  });
}

export function consumeRepositorySystemIdentity(projectId: string): SourceControlCommitIdentity | null {
  const identity = state.repositorySystemIdentities[projectId] ?? null;
  if (!identity) return null;
  const repositorySystemIdentities = { ...state.repositorySystemIdentities };
  delete repositorySystemIdentities[projectId];
  publish({ ...state, repositorySystemIdentities });
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
    if (event.key !== KEY && event.key !== LEGACY_KEY) return;
    state = read();
    for (const listener of [...listeners]) listener();
  });
}
