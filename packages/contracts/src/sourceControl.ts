export type SourceControlProvider = "github" | "gitlab" | "generic";
export type SourceControlProtocol = "http" | "https" | "ssh";
export type SourceControlAuthMode =
  | "system-git"
  | "ssh-agent"
  | "credential-helper"
  | "provider-cli"
  | "managed";

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
 * User-facing source-control identity. Secret material never belongs here:
 * credentialRef/accountRef are opaque references to provider-owned secure
 * storage only.
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
  };
  metadata?: Readonly<Record<string, string>>;
}

export const SYSTEM_SOURCE_CONTROL_PROFILE_ID = "system-git";

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
