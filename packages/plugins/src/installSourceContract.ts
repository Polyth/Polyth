/** Browser and server share this so the installer UI cannot advertise disabled
 *  sources, and both agree on what a supported source resolves to. */

/** A forge whose repository URL maps to a downloadable archive. The
 *  host performs the download; the UI only describes the source. */
interface Forge {
  hosts: readonly string[];
  /** Archive URL for a repository path and ref; null when the shape is invalid. */
  archive(path: string, ref: string): string | null;
}

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

function segments(path: string, min: number, max: number): string[] | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < min || parts.length > max) return null;
  if (parts.some((part) => !REPO_SEGMENT.test(part) || part === "." || part === "..")) return null;
  return parts;
}

const FORGES: readonly Forge[] = [
  {
    // github.com/owner/repo[/tree/<ref>|/releases/tag/<ref>]
    hosts: ["github.com", "www.github.com"],
    archive(path, ref) {
      const parts = segments(path, 2, 2);
      if (!parts) return null;
      const [owner, repo] = parts as [string, string];
      const name = repo.replace(/\.git$/i, "");
      if (!name) return null;
      return `https://codeload.github.com/${owner}/${name}/zip/${encodeURIComponent(ref)}`;
    },
  },
  {
    // gitlab.com/<group…>/<repo>[/-/tree/<ref>] — namespaced groups allowed.
    hosts: ["gitlab.com", "www.gitlab.com"],
    archive(path, ref) {
      const parts = segments(path, 2, 8);
      if (!parts) return null;
      const repo = (parts.at(-1) ?? "").replace(/\.git$/i, "");
      if (!repo) return null;
      const namespace = [...parts.slice(0, -1), repo].join("/");
      return `https://gitlab.com/${namespace}/-/archive/${ref}/${repo}-${ref}.zip`;
    },
  },
  {
    // codeberg.org/owner/repo[/src/branch/<ref>]
    hosts: ["codeberg.org", "www.codeberg.org"],
    archive(path, ref) {
      const parts = segments(path, 2, 2);
      if (!parts) return null;
      const [owner, repo] = parts as [string, string];
      const name = repo.replace(/\.git$/i, "");
      if (!name) return null;
      return `https://codeberg.org/${owner}/${name}/archive/${ref}.zip`;
    },
  },
];

export type InstallSourceKind =
  | "archive-url"
  | "repository"
  | "file"
  | "dev-path"
  | "zip-path"
  | "invalid";

export interface InstallSourceDescription {
  kind: InstallSourceKind;
  /** Short human label for the source, e.g. "cdn.example.com/pkg.zip". */
  label: string;
  /** Public archive URL, fetched before any authenticated acquisition. */
  archiveUrl?: string;
  /** Repository entries only: "owner/repo@ref" as understood by the host. */
  repository?: string;
  /** Canonical forge host/path/ref used by authenticated local checkout fallbacks. */
  repositoryHost?: string;
  repositoryPath?: string;
  repositoryRef?: string;
}

export const DEFAULT_REPOSITORY_REF = "HEAD";

function httpsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url;
}

/** Split a repository URL into its forge, repository path, and ref. Ref
 *  shapes are the ones a forge's web UI itself uses; anything else is
 *  invalid rather than guessed. */
function repositoryParts(url: URL): { forge: Forge; path: string; ref: string } | null {
  const forge = FORGES.find((candidate) => candidate.hosts.includes(url.hostname.toLowerCase()));
  if (!forge) return null;
  const raw = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!raw) return null;
  const marker = (needle: string): [string, string] | null => {
    const index = raw.indexOf(needle);
    if (index < 0) return null;
    const head = raw.slice(0, index).replace(/\/+$/, "");
    const tail = raw.slice(index + needle.length).replace(/^\/+|\/+$/g, "");
    let ref: string;
    try { ref = decodeURIComponent(tail); } catch { return null; }
    return head && ref && !head.endsWith("/-") ? [head, ref] : null;
  };
  // Longest marker first: "/-/tree/" contains "/tree/", so a GitLab ref URL
  // must not be read as a GitHub-style path.
  for (const needle of ["/-/tree/", "/src/branch/", "/releases/tag/", "/tree/"]) {
    const found = marker(needle);
    if (found) return { forge, path: found[0], ref: found[1] };
  }
  return { forge, path: raw, ref: DEFAULT_REPOSITORY_REF };
}

/** True for a supported forge repository URL that the host can turn into an
 *  archive download. A plain `.zip` URL is an archive, not a repository. */
export function isRepositorySource(source: string): boolean {
  const url = httpsUrl(source.trim());
  if (!url) return false;
  const parts = repositoryParts(url);
  // Resolution, not recognition, decides: a forge path the template cannot
  // build an archive URL for is not a repository source.
  return Boolean(parts && parts.forge.archive(parts.path, parts.ref));
}

/** Resolve a supported install source to what the host will actually fetch.
 *  Pure and browser-safe: the settings UI uses the same answer the server
 *  uses, so a valid-looking link is never rejected after the click. */
export function describeInstallSource(source: string, allowDevPath = false): InstallSourceDescription {
  const value = source.trim();
  if (!value) return { kind: "invalid", label: "" };
  if (value.startsWith("npm:") || value.startsWith("git:") || value.startsWith("git+")) {
    return { kind: "invalid", label: value };
  }
  if (value.startsWith("file:")) {
    const rel = value.slice(5).replace(/^\/+/, "");
    return rel ? { kind: "file", label: rel } : { kind: "invalid", label: value };
  }
  if (value.startsWith("path:") || value.startsWith("dir:")) {
    const rel = value.slice(value.indexOf(":") + 1);
    return allowDevPath && rel
      ? { kind: "dev-path", label: rel }
      : { kind: "invalid", label: value };
  }
  if (value.startsWith("zip:https://")) {
    return describeInstallSource(value.slice(4), allowDevPath);
  }
  // Anything carrying a URL scheme must be https; a plain "http://…zip" is a
  // supported-looking string that would silently become a local file path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!value.startsWith("https://")) return { kind: "invalid", label: value };
    const url = httpsUrl(value);
    if (!url) return { kind: "invalid", label: value };
    const repo = repositoryParts(url);
    if (repo) {
      const repositoryPath = repo.path.replace(/\.git$/i, "");
      const archiveUrl = repo.forge.archive(repo.path, repo.ref);
      if (!archiveUrl) return { kind: "invalid", label: value };
      return {
        kind: "repository",
        label: `${url.hostname.toLowerCase()}/${repositoryPath}@${repo.ref}`,
        archiveUrl,
        repository: `${repositoryPath}@${repo.ref}`,
        repositoryHost: url.hostname.toLowerCase(),
        repositoryPath,
        repositoryRef: repo.ref,
      };
    }
    return { kind: "archive-url", label: url.hostname.toLowerCase(), archiveUrl: url.toString() };
  }
  if (value.endsWith(".zip")) return { kind: "zip-path", label: value };
  return { kind: "invalid", label: value };
}

export function isSupportedInstallSource(source: string, allowDevPath = false): boolean {
  return describeInstallSource(source, allowDevPath).kind !== "invalid";
}
