import type { SpaceContext } from "./index.ts";

export type SourceControlProvider = "github" | "gitlab" | "generic";
export type SourceControlProtocol = "http" | "https" | "ssh";
export type SourceControlAuthMode =
  | "system-git"
  | "ssh-agent"
  | "credential-helper"
  | "provider-cli"
  | "managed"
  | "ssh-key"
  /** Polyth's own fetch/pull/push sign in with the profile's `hostingAccount`. */
  | "account"
  /** No credentials: the checkout's Git config hides the host's helpers and SSH keys. */
  | "anonymous";

/** A code-hosting account a commit identity is tied to (public metadata only). */
export interface SourceControlHostingAccountRef {
  provider: string;
  accountId: string;
  login: string;
  origin: string;
}

export interface SourceControlRemote {
  url: string;
  hostname: string;
  fullPath: string;
  protocol: SourceControlProtocol;
}

export interface SourceControlCommitIdentity {
  name: string;
  email: string;
}

/**
 * User-facing commit identity. Secret material never belongs here:
 * credentialRef/accountRef are opaque references to provider-owned secure
 * storage only. The current Git transport uses the repository's configured
 * Git/SSH environment; the authentication mode is descriptive metadata, not
 * a secret input or a credential switch in this profile.
 */
export interface SourceControlProfile {
  id: string;
  label: string;
  provider: SourceControlProvider;
  host?: string;
  account?: string;
  username?: string;
  commitAuthor?: SourceControlCommitIdentity;
  authentication: {
    mode: SourceControlAuthMode;
    credentialRef?: string;
    accountRef?: string;
    /** Absolute private-key path on the Polyth server host; only with mode "ssh-key". */
    identityFile?: string;
  };
  /** Absolute SSH public-key path (`~/.ssh/*.pub`) commits are signed with
   *  (`gpg.format=ssh`); absent = commits are not signed by this identity. */
  signingKey?: string;
  /** The code-hosting account this identity belongs to. With authentication
   *  mode "account", Polyth's own fetch/pull/push use it for the project. */
  hostingAccount?: SourceControlHostingAccountRef;
  metadata?: Readonly<Record<string, string>>;
}

/** Server-stored (per Space) profile selection state. `repositoryProfileIds`
 *  is each project's own identity (keyed by project id); a project without one
 *  uses `globalDefaultProfileId`, then the checkout's System Git config. */
export interface SourceControlProfileState {
  profiles: SourceControlProfile[];
  globalDefaultProfileId: string | null;
  repositoryProfileIds: Record<string, string>;
  repositorySystemIdentities: Record<string, SourceControlCommitIdentity>;
}

export const SYSTEM_SOURCE_CONTROL_PROFILE_ID = "system-git";

/** Every authentication mode a stored profile may carry. */
export const SOURCE_CONTROL_AUTH_MODES: readonly SourceControlAuthMode[] = [
  "system-git", "ssh-agent", "credential-helper", "provider-cli", "managed", "ssh-key", "account", "anonymous",
];

/** A stored hosting-account reference, or null when it is incomplete. */
export function parseSourceControlHostingAccountRef(value: unknown): SourceControlHostingAccountRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const field = (key: string): string | null =>
    typeof row[key] === "string" && row[key].trim() && row[key].length <= 512 ? row[key].trim() : null;
  const provider = field("provider"), accountId = field("accountId"), login = field("login"), origin = field("origin");
  if (!provider || !accountId || !login || !origin) return null;
  try {
    const url = new URL(origin);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin) return null;
  } catch { return null; }
  return { provider, accountId, login, origin };
}

/** The identity a project uses: its own choice, else the default for all
 *  projects. Null means System Git (the checkout's own configuration). */
export function projectSourceControlProfile(
  state: Pick<SourceControlProfileState, "profiles" | "repositoryProfileIds" | "globalDefaultProfileId">,
  projectId: string,
): SourceControlProfile | null {
  const id = state.repositoryProfileIds[projectId] ?? state.globalDefaultProfileId;
  if (!id || id === SYSTEM_SOURCE_CONTROL_PROFILE_ID) return null;
  return state.profiles.find((profile) => profile.id === id) ?? null;
}

/**
 * A code-hosting account a provider package can authenticate Git transport
 * with (a GitHub `gh` login, a GitLab account connected in Polyth, …). Public
 * metadata only: credential values never cross this boundary.
 */
export interface SourceControlHostingAccount {
  /** Provider package id that owns the account, e.g. "github" or "gitlab". */
  provider: string;
  /** Provider-scoped opaque id. */
  accountId: string;
  /** Provider presentation name, e.g. "GitHub". */
  providerLabel: string;
  login: string;
  /** Web origin of the hosting instance, e.g. "https://github.com". */
  origin: string;
  label?: string;
  /**
   * "token": Polyth supplies the account's credential to HTTPS Git transport.
   * "system": the host's own Git credential helpers authenticate the account.
   */
  transport: "token" | "system";
  /** Provider-side default/active account for its host, when that concept exists. */
  active?: boolean;
  /**
   * Whose account this is (Spaces §14.4). `personal`: the requesting person's
   * own, turned on in this Space; `service`: the Space's shared account;
   * `installation`: the host's own logins (`gh`, `glab`), usable only by the
   * instance owner on a local-trusted install. Absent means `service`.
   */
  owner?: SourceControlAccountOwner;
}

export type SourceControlAccountOwner = "personal" | "service" | "installation";

/** A person's commit identity (Profile → Git), stored outside every Space. */
export interface PersonGitProfileDto {
  profile: (SourceControlCommitIdentity & { updatedAt: number }) | null;
  /** True when, without a profile, Polyth keeps the checkout's own Git
   *  configuration for this person (the instance owner on a local-trusted install). */
  usesInstallationFallback: boolean;
}

/** One person-owned hosting account as its owner sees it from a Space. */
export interface PersonHostingAccountDto {
  id: string;
  origin: string;
  login: string;
  label: string;
  /** Turned on in the Space the request was made in. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** The account a project uses for clone, fetch, pull and push. */
export interface SourceControlAccountBinding {
  projectId: string;
  provider: string;
  accountId: string;
  login: string;
  origin: string;
  updatedAt: number;
}

export interface SourceControlTransportCredential {
  username: string;
  password: string;
}

/**
 * Server-only provider seam registered with the Git package. `credential`
 * returns null when the host's own Git helpers authenticate the account; it
 * must throw a sanitized error (never the secret) when the account cannot be
 * used. `bindProject` lets the provider record its own project binding (for
 * example the account its API views use) after Polyth bound the project.
 */
export interface SourceControlCredentialProvider {
  id: string;
  accounts(space: SpaceContext): Promise<SourceControlHostingAccount[]>;
  credential(space: SpaceContext, accountId: string): Promise<SourceControlTransportCredential | null>;
  bindProject?(space: SpaceContext, input: {
    projectId: string;
    accountId: string;
    repository: string;
  }): Promise<void>;
}

export interface SourceControlCredentialRegistry {
  register(provider: SourceControlCredentialProvider): () => void;
  get(id: string): SourceControlCredentialProvider | undefined;
  list(): SourceControlCredentialProvider[];
}

export const SOURCE_CONTROL_CREDENTIAL_REGISTRY = "source-control.credentials";

/** Normalized web origin of a remote: HTTPS/HTTP keep their own origin, SSH
 * remotes map to the HTTPS origin of the same host. */
export function sourceControlRemoteOrigin(remote: SourceControlRemote): string {
  if (remote.protocol === "http" || remote.protocol === "https") {
    try { return new URL(remote.url).origin; } catch { /* fall through */ }
  }
  return `https://${remote.hostname.includes(":") ? `[${remote.hostname}]` : remote.hostname}`;
}

/** An account applies to a remote when it belongs to the same host. HTTP(S)
 * remotes must match the exact origin (scheme and port); SSH remotes match by
 * hostname because SSH ports and users differ from the web origin. */
export function sourceControlAccountMatchesRemote(
  account: Pick<SourceControlHostingAccount, "origin">,
  remote: SourceControlRemote,
): boolean {
  let origin: URL;
  try { origin = new URL(account.origin); } catch { return false; }
  if (remote.protocol === "http" || remote.protocol === "https") {
    try { return new URL(remote.url).origin === origin.origin; } catch { return false; }
  }
  return normalizeSourceControlHost(origin.hostname) === remote.hostname;
}

export type SourceControlResolutionSource = "repository" | "project" | "global" | "system";

export type SourceControlResolution =
  | {
      ok: true;
      source: SourceControlResolutionSource;
      profile: SourceControlProfile | null;
      provider: SourceControlProvider;
      remote: SourceControlRemote | null;
      commitAuthor: SourceControlCommitIdentity | null;
      authentication: SourceControlProfile["authentication"];
    }
  | {
      ok: false;
      source: Exclude<SourceControlResolutionSource, "system">;
      profileId: string;
      profile: SourceControlProfile | null;
      provider: SourceControlProvider;
      remote: SourceControlRemote | null;
      reason: "profile-not-found" | "profile-host-mismatch";
    };

export interface ResolveSourceControlInput {
  profiles: readonly SourceControlProfile[];
  remote?: SourceControlRemote | null;
  repositoryProfileId?: string | null;
  projectProfileId?: string | null;
  globalProfileId?: string | null;
  systemIdentity?: SourceControlCommitIdentity | null;
}

const cleanPath = (path: string): string | null => {
  const clean = path.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/$/, "");
  const parts = clean.split("/");
  if (
    !clean || clean.length > 2048 || parts.length < 2
    || /[\0-\x20\\?#]/.test(clean)
    || parts.some((part) => !part || part === "." || part === "..")
  ) return null;
  return clean;
};

export function normalizeSourceControlHost(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return raw.replace(/^\[|\]$/g, "").replace(/\/$/, "").toLowerCase();
  }
}

/** Parse HTTP(S), SSH URLs, and SCP-style SSH remotes without contacting them. */
export function parseSourceControlRemoteUrl(raw: string): SourceControlRemote | null {
  const value = raw.trim();
  if (!value || value !== raw || value.length > 2048 || /[\0-\x20\\?#]/.test(value)) return null;
  if (value.includes("://")) try {
    const url = new URL(value);
    const protocol = url.protocol.replace(":", "") as SourceControlProtocol;
    if (protocol !== "http" && protocol !== "https" && protocol !== "ssh") return null;
    if (url.username && url.protocol !== "ssh:") return null;
    if (url.password || url.search || url.hash) return null;
    const fullPath = cleanPath(decodeURIComponent(url.pathname));
    if (!fullPath) return null;
    return {
      url: value,
      hostname: normalizeSourceControlHost(url.hostname),
      fullPath,
      protocol,
    };
  } catch {
    return null;
  }

  const separator = value.indexOf(":");
  const at = value.indexOf("@");
  if (separator <= 0 || (at >= 0 && at > separator)) return null;
  const match = value.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/);
  const fullPath = match?.[2] ? cleanPath(match[2]) : null;
  if (!match?.[1] || !fullPath) return null;
  return {
    url: value,
    hostname: normalizeSourceControlHost(match[1]),
    fullPath,
    protocol: "ssh",
  };
}

const defaultHostForProvider = (provider: SourceControlProvider): string | null => {
  if (provider === "github") return "github.com";
  if (provider === "gitlab") return "gitlab.com";
  return null;
};

export function sourceControlProfileMatchesRemote(
  profile: SourceControlProfile,
  remote: SourceControlRemote | null | undefined,
): boolean {
  if (!remote) return true;
  const profileHost = normalizeSourceControlHost(profile.host ?? "") || defaultHostForProvider(profile.provider);
  if (profileHost) return profileHost === remote.hostname;
  return profile.provider === "generic";
}

export function inferSourceControlProvider(
  remote: SourceControlRemote | null | undefined,
  profiles: readonly SourceControlProfile[] = [],
): SourceControlProvider {
  if (!remote) return "generic";
  if (remote.hostname === "github.com") return "github";
  if (remote.hostname === "gitlab.com") return "gitlab";
  const providers = new Set(
    profiles
      .filter((profile) => profile.provider !== "generic" && sourceControlProfileMatchesRemote(profile, remote))
      .map((profile) => profile.provider),
  );
  return providers.size === 1 ? [...providers][0]! : "generic";
}

export function matchingSourceControlProfiles(
  profiles: readonly SourceControlProfile[],
  remote: SourceControlRemote | null | undefined,
): SourceControlProfile[] {
  return profiles.filter((profile) => sourceControlProfileMatchesRemote(profile, remote));
}

export function resolveSourceControlContext(input: ResolveSourceControlInput): SourceControlResolution {
  const remote = input.remote ?? null;
  const system = (source: SourceControlResolutionSource = "system"): SourceControlResolution => ({
    ok: true,
    source,
    profile: null,
    provider: inferSourceControlProvider(remote, input.profiles),
    remote,
    commitAuthor: input.systemIdentity ?? null,
    authentication: { mode: "system-git" },
  });

  const candidates: Array<{
    source: Exclude<SourceControlResolutionSource, "system">;
    id: string | null | undefined;
  }> = [
    { source: "repository", id: input.repositoryProfileId },
    { source: "project", id: input.projectProfileId },
    { source: "global", id: input.globalProfileId },
  ];

  for (const candidate of candidates) {
    if (!candidate.id) continue;
    if (candidate.id === SYSTEM_SOURCE_CONTROL_PROFILE_ID) return system(candidate.source);
    const profile = input.profiles.find((row) => row.id === candidate.id) ?? null;
    if (!profile) {
      return {
        ok: false,
        source: candidate.source,
        profileId: candidate.id,
        profile: null,
        provider: inferSourceControlProvider(remote, input.profiles),
        remote,
        reason: "profile-not-found",
      };
    }
    if (!sourceControlProfileMatchesRemote(profile, remote)) {
      return {
        ok: false,
        source: candidate.source,
        profileId: profile.id,
        profile,
        provider: inferSourceControlProvider(remote, input.profiles),
        remote,
        reason: "profile-host-mismatch",
      };
    }
    return {
      ok: true,
      source: candidate.source,
      profile,
      provider: profile.provider === "generic"
        ? inferSourceControlProvider(remote, input.profiles)
        : profile.provider,
      remote,
      commitAuthor: profile.commitAuthor ?? input.systemIdentity ?? null,
      authentication: profile.authentication,
    };
  }

  return system();
}
