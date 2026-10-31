// Links found in message text, offered as "open in Browser". Pure and
// browser-safe: this only recognizes candidate http(s) URLs. Whether the
// embedded browser may actually visit one is still decided server-side
// (navigation policy + origin approval), never here.

export interface MessageLink {
  url: string;
  host: string;
  /** Compact host + path for menus; the full URL stays in `url`. */
  label: string;
  /** Set for GitHub/GitLab/Bitbucket pull or merge request pages. */
  pullRequest?: { provider: "github" | "gitlab" | "bitbucket"; repo: string; number: number };
}

const MAX_LINKS = 8;
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\^{}|[\]]+/gi;
const TRAILING = /[.,;:!?'")\]}>*_]/;

/** Drop sentence punctuation, and an unbalanced closing paren that Markdown wrapped around. */
function trimUrl(raw: string): string {
  let url = raw;
  while (url && TRAILING.test(url.slice(-1))) {
    const last = url.slice(-1);
    // Keep a ")" that closes a "(" inside the URL, e.g. wikipedia links.
    if (last === ")" && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return url;
}

export function classifyPullRequest(url: URL): MessageLink["pullRequest"] | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (host === "github.com" && parts.length >= 4 && parts[2] === "pull" && /^\d+$/.test(parts[3]!)) {
    return { provider: "github", repo: `${parts[0]}/${parts[1]}`, number: Number(parts[3]) };
  }
  if (host === "bitbucket.org" && parts.length >= 4 && parts[2] === "pull-requests" && /^\d+$/.test(parts[3]!)) {
    return { provider: "bitbucket", repo: `${parts[0]}/${parts[1]}`, number: Number(parts[3]) };
  }
  // GitLab nests groups before "/-/merge_requests/<n>" (self-hosted instances too).
  if (host.includes("gitlab")) {
    const marker = parts.indexOf("merge_requests");
    if (marker >= 3 && parts[marker - 1] === "-" && /^\d+$/.test(parts[marker + 1] ?? "")) {
      return { provider: "gitlab", repo: parts.slice(0, marker - 1).join("/"), number: Number(parts[marker + 1]) };
    }
  }
  return undefined;
}

function compactLabel(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  const id = `${url.host}${path}`;
  return id.length > 56 ? `${id.slice(0, 55)}…` : id;
}

/** Distinct http(s) links in reading order; pull requests are listed first. */
export function extractMessageLinks(text: string | null | undefined, limit = MAX_LINKS): MessageLink[] {
  if (!text) return [];
  const seen = new Set<string>();
  const links: MessageLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimUrl(match[0]);
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { continue; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    // Credentials in a URL are never worth surfacing in a menu.
    if (parsed.username || parsed.password) continue;
    parsed.hash = parsed.hash.length > 1 ? parsed.hash : "";
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const pullRequest = classifyPullRequest(parsed);
    links.push({ url, host: parsed.hostname, label: compactLabel(parsed), ...(pullRequest ? { pullRequest } : {}) });
  }
  // Stable partition: PRs first, otherwise reading order.
  const ordered = [...links.filter((l) => l.pullRequest), ...links.filter((l) => !l.pullRequest)];
  return ordered.slice(0, limit);
}

/** Short label for a PR link, e.g. "owner/repo #42". */
export function pullRequestLabel(link: MessageLink): string | null {
  const pr = link.pullRequest;
  if (!pr) return null;
  return `${pr.repo}${pr.provider === "gitlab" ? " !" : " #"}${pr.number}`;
}

/** Lines of reader-mode text: collapse the blank-line runs a page dump leaves. */
export function readerParagraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    // Tabs survive (as one "\t") so page-table rows keep their columns.
    .map((line) => line.replace(/[ \u00a0]+/g, " ").replace(/ ?\t[\t ]*/g, "\t").replace(/^[\t ]+|[\t ]+$/g, ""))
    .reduce<string[]>((acc, line) => {
      if (line) acc.push(line);
      else if (acc.length && acc[acc.length - 1] !== "") acc.push("");
      return acc;
    }, [])
    .filter((line, index, all) => !(line === "" && (index === 0 || index === all.length - 1)));
}
