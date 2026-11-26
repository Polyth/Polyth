// GitHub as an event source for Polyth Agents: a wake on source `github`
// names a repository (a `repo equals owner/name` filter, or the project's own
// GitHub remote) and this watch polls it, as the agent's owner, for new
// commits, issues, pull requests, comments, discussions and releases. Each
// new item becomes one integration event targeted at that one wake, so no
// other agent — and no other person — sees what one person's account read.
//
// Polling, not webhooks: it works without a public URL or admin rights on the
// repository. REST reads are conditional (ETag), and GitHub does not count a
// 304 against the rate limit, so an unchanged repository costs nothing.
// Discussions exist only in GraphQL and are read less often.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteSync,
  type AgentEventPublication,
  type AgentEventSourceDescriptor,
  type AgentEventSources,
  type AgentEventSubscription,
} from "@polyth/plugins";

export const GITHUB_EVENT_SOURCE: AgentEventSourceDescriptor = {
  id: "github",
  label: "GitHub",
  types: [
    { id: "push", label: "New commits" },
    { id: "issue-opened", label: "Issue opened" },
    { id: "pull-request-opened", label: "Pull request opened" },
    { id: "comment", label: "Comment on an issue or pull request" },
    { id: "discussion-opened", label: "Discussion opened" },
    { id: "discussion-comment", label: "Discussion comment" },
    { id: "release", label: "Release published" },
  ],
  fields: [
    { id: "repo", label: "Repository (owner/name)" },
    { id: "branch", label: "Branch" },
    { id: "author", label: "Author" },
    { id: "labels", label: "Labels" },
    { id: "paths", label: "Changed files" },
    { id: "category", label: "Discussion category" },
  ],
};

const REST_KINDS = {
  push: ["push"],
  issues: ["issue-opened", "pull-request-opened"],
  comments: ["comment"],
  releases: ["release"],
  discussions: ["discussion-opened"],
  discussionComments: ["discussion-comment"],
} as const;
type Feed = keyof typeof REST_KINDS;
const FEEDS = Object.keys(REST_KINDS) as Feed[];
const GRAPHQL_FEEDS: ReadonlySet<Feed> = new Set(["discussions", "discussionComments"]);

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** New items one feed reports per poll; older ones are summarised by count. */
const MAX_ITEMS_PER_FEED = 20;
const MAX_BRANCH_CHANGES = 10;
const TEXT_MAX = 1_500;
const PATHS_MAX = 2_000;

/** An answer of one `gh api` call. 304 = unchanged since `etag`. */
export interface GhApiAnswer {
  status: number;
  etag?: string;
  body: unknown;
}

/** Whose account polls for one wake, decided like the owner's own request. */
export type RepoWatchAccess =
  | { key: string; api(args: string[]): Promise<GhApiAnswer> }
  | { refused: string };

export interface GithubRepoWatchDeps {
  /** The Agents package's event sources; resolved on every tick (lazy). */
  sources(): AgentEventSources | undefined;
  /** `owner/name` and host of the project's own GitHub remote, if any. */
  projectRepo(projectId: string): Promise<{ repo: string; host: string } | undefined>;
  /** The owner's access to `host` in that project; `key` names the account
   *  (never the token), so wakes reading as the same account share a poll. */
  access(sub: AgentEventSubscription, host: string): Promise<RepoWatchAccess>;
  /** Persisted cursors of one Space (what each watch has already seen). */
  load(spaceId: string): Record<string, WatchCursor>;
  save(spaceId: string, cursors: Record<string, WatchCursor>): void;
  now?: () => number;
  /** Graphql feeds are read at most this often (default 5 minutes). */
  graphqlEveryMs?: number;
  warn?: (message: string) => void;
}

/** What one watch (account × repository) has already seen. Absent fields
 *  are feeds never read: their first read is a baseline, not news. */
export interface WatchCursor {
  branches?: Record<string, string>;
  issue?: number;
  comment?: number;
  release?: number;
  discussion?: number;
  discussionComment?: number;
  /** When the watch was last used; stale entries are dropped. */
  usedAt?: number;
}

interface NewEvent {
  type: string;
  title: string;
  fields: Record<string, string>;
}

export interface GithubRepoWatch {
  /** One poll of every subscribed repository; returns events published. */
  tick(): Promise<number>;
  start(everyMs?: number): void;
  stop(): void;
}

const clip = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};
const firstLine = (text: unknown): string => clip(String(text ?? "").split(/\r?\n/, 1)[0] ?? "", 120);
const asArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const login = (value: unknown): string => String(record(value).login ?? "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const STALE_MS = 7 * 24 * 60 * 60_000;

/** Repositories one wake names: `repo equals owner/name` filters. */
export function reposOf(sub: AgentEventSubscription): string[] {
  return [...new Set(sub.filters
    .filter((filter) => filter.field === "repo" && filter.op === "equals")
    .map((filter) => filter.value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, ""))
    .filter((repo) => REPO_PATTERN.test(repo))
    .map((repo) => repo.toLowerCase()))];
}

/** Parse `gh api -i` output: a status line, headers, a blank line, the body. */
export function parseGhInclude(stdout: string): GhApiAnswer | undefined {
  const text = stdout.replace(/\r\n/g, "\n");
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(text);
  if (!status) return undefined;
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const raw = split === -1 ? "" : text.slice(split + 2).trim();
  const etag = /^etag:\s*(.+)$/im.exec(head)?.[1]?.trim();
  let body: unknown = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = null; }
  }
  return { status: Number(status[1]), ...(etag ? { etag } : {}), body };
}

/** The feeds a set of event types needs. */
function feedsFor(types: Iterable<string>): Set<Feed> {
  const wanted = new Set(types);
  return new Set(FEEDS.filter((feed) => REST_KINDS[feed].some((type) => wanted.has(type))));
}

interface Watch {
  key: string;
  spaceId: string;
  repo: string;
  api(args: string[]): Promise<GhApiAnswer>;
  feeds: Set<Feed>;
  subs: AgentEventSubscription[];
}

const DISCUSSIONS_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussions(first:${MAX_ITEMS_PER_FEED},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title url body author{login} category{name}}}}}`;
const DISCUSSION_COMMENTS_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussions(first:10,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title comments(last:10){nodes{databaseId url body author{login}}}}}}}`;

export function createGithubRepoWatch(deps: GithubRepoWatchDeps): GithubRepoWatch {
  const now = deps.now ?? Date.now;
  const graphqlEveryMs = deps.graphqlEveryMs ?? 5 * 60_000;
  const warn = deps.warn ?? ((message: string) => console.warn(`[github] ${message}`));
  /** ETags per watch and endpoint; memory only (a restart reads once in full). */
  const etags = new Map<string, string>();
  const graphqlAt = new Map<string, number>();
  /** One warning per watch and reason per hour. */
  const warned = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const warnOnce = (key: string, message: string): void => {
    const at = warned.get(key);
    if (at !== undefined && now() - at < 60 * 60_000) return;
    warned.set(key, now());
    warn(message);
  };

  /** A GET, conditional for the listing endpoints polled every tick (their
   *  ETag is remembered); null when unchanged or failed. */
  const read = async (watch: Watch, endpoint: string, conditional = true): Promise<unknown | null> => {
    const tagKey = `${watch.key}|${endpoint}`;
    const tag = conditional ? etags.get(tagKey) : undefined;
    const answer = await watch.api(["api", "-i", "-H", "Accept: application/vnd.github+json", ...(tag ? ["-H", `If-None-Match: ${tag}`] : []), endpoint]);
    if (answer.status === 304) return null;
    if (answer.status !== 200) {
      warnOnce(`${watch.key}|${answer.status}`, `repository watch ${watch.repo}: GitHub answered ${answer.status} for ${endpoint.split("?")[0]}`);
      return null;
    }
    if (conditional && answer.etag) etags.set(tagKey, answer.etag);
    return answer.body;
  };

  const graphql = async (watch: Watch, query: string): Promise<Record<string, unknown> | null> => {
    const [owner, name] = watch.repo.split("/") as [string, string];
    const answer = await watch.api(["api", "-i", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`]);
    const body = record(answer.body);
    if (answer.status !== 200 || Array.isArray(body.errors)) {
      warnOnce(`${watch.key}|graphql`, `repository watch ${watch.repo}: discussions could not be read (${answer.status})`);
      return null;
    }
    return record(record(record(body.data).repository).discussions);
  };

  /** New items above `cursor` (ids grow), oldest first, and the new cursor. */
  const above = <T>(items: T[], idOf: (item: T) => number, cursor: number | undefined): { fresh: T[]; next: number } => {
    const max = Math.max(cursor ?? 0, ...items.map(idOf));
    if (cursor === undefined) return { fresh: [], next: max };
    return { fresh: items.filter((item) => idOf(item) > cursor).sort((a, b) => idOf(a) - idOf(b)), next: max };
  };

  const pollPush = async (watch: Watch, cursor: WatchCursor, out: NewEvent[]): Promise<void> => {
    const body = await read(watch, `repos/${watch.repo}/branches?per_page=100`);
    if (body === null) return;
    const heads: Record<string, string> = {};
    for (const branch of asArray(body)) {
      const name = String(branch.name ?? "");
      const sha = String(record(branch.commit).sha ?? "");
      if (name && /^[0-9a-f]{40}$/.test(sha)) heads[name] = sha;
    }
    const before = cursor.branches;
    cursor.branches = heads;
    if (!before) return;
    const changed = Object.entries(heads).filter(([name, sha]) => before[name] !== sha).slice(0, MAX_BRANCH_CHANGES);
    for (const [branch, sha] of changed) {
      const old = before[branch];
      const detail = record(old
        ? await read(watch, `repos/${watch.repo}/compare/${old}...${sha}`, false)
        : await read(watch, `repos/${watch.repo}/commits/${sha}`, false));
      const commits = old ? asArray(detail.commits) : [detail];
      const files = asArray(detail.files).map((file) => String(file.filename ?? "")).filter(Boolean);
      const newest = commits.at(-1);
      const authors = [...new Set(commits.map((commit) => login(commit.author) || String(record(record(commit.commit).author).name ?? "")).filter(Boolean))];
      const lines = commits.slice(-15).map((commit) =>
        `${String(commit.sha ?? "").slice(0, 7)} ${firstLine(record(commit.commit).message)}${login(commit.author) ? ` (${login(commit.author)})` : ""}`);
      const count = old ? num(detail.total_commits) || commits.length : 1;
      // The old head may be gone (force push + GC): report the move alone.
      const what = !old ? "New branch" : count ? `${count} new commit${count === 1 ? "" : "s"}` : "Updated";
      out.push({
        type: "push",
        title: clip(`${what} on ${branch}${newest?.sha ? `: ${firstLine(record(newest.commit).message)}` : ""}`, 160),
        fields: {
          branch,
          sha,
          author: authors.join(", "),
          paths: clip(files.join("\n"), PATHS_MAX),
          url: old ? String(detail.html_url ?? `https://github.com/${watch.repo}/compare/${old}...${sha}`) : `https://github.com/${watch.repo}/tree/${branch}`,
          ...(String(detail.status ?? "") === "diverged" ? { forced: "true" } : {}),
          text: clip(lines.join("\n"), TEXT_MAX),
        },
      });
    }
  };

  const pollIssues = async (watch: Watch, cursor: WatchCursor, out: NewEvent[]): Promise<void> => {
    const body = await read(watch, `repos/${watch.repo}/issues?state=all&sort=created&direction=desc&per_page=${MAX_ITEMS_PER_FEED}`);
    if (body === null) return;
    const { fresh, next } = above(asArray(body), (issue) => num(issue.number), cursor.issue);
    cursor.issue = next;
    for (const issue of fresh) {
      const pull = !!issue.pull_request;
      out.push({
        type: pull ? "pull-request-opened" : "issue-opened",
        title: clip(`#${num(issue.number)} ${String(issue.title ?? "")}`, 160),
        fields: {
          number: String(num(issue.number)),
          author: login(issue.user),
          labels: asArray(issue.labels).map((label) => String(label.name ?? "")).filter(Boolean).join(", "),
          url: String(issue.html_url ?? ""),
          text: clip(issue.body, TEXT_MAX),
        },
      });
    }
  };

  const pollComments = async (watch: Watch, cursor: WatchCursor, out: NewEvent[]): Promise<void> => {
    const body = await read(watch, `repos/${watch.repo}/issues/comments?sort=created&direction=desc&per_page=${MAX_ITEMS_PER_FEED}`);
    if (body === null) return;
    const { fresh, next } = above(asArray(body), (comment) => num(comment.id), cursor.comment);
    cursor.comment = next;
    for (const comment of fresh) {
      const number = /\/issues\/(\d+)$/.exec(String(comment.issue_url ?? ""))?.[1] ?? "";
      const author = login(comment.user);
      out.push({
        type: "comment",
        title: clip(`Comment${author ? ` by ${author}` : ""} on #${number}`, 160),
        fields: { number, author, url: String(comment.html_url ?? ""), text: clip(comment.body, TEXT_MAX) },
      });
    }
  };

  const pollReleases = async (watch: Watch, cursor: WatchCursor, out: NewEvent[]): Promise<void> => {
    const body = await read(watch, `repos/${watch.repo}/releases?per_page=10`);
    if (body === null) return;
    const published = asArray(body).filter((release) => !release.draft);
    const { fresh, next } = above(published, (release) => num(release.id), cursor.release);
    cursor.release = next;
    for (const release of fresh) {
      out.push({
        type: "release",
        title: clip(`Release ${String(release.name || release.tag_name || "")}`, 160),
        fields: {
          tag: String(release.tag_name ?? ""),
          author: login(release.author),
          url: String(release.html_url ?? ""),
          ...(release.prerelease ? { prerelease: "true" } : {}),
          text: clip(release.body, TEXT_MAX),
        },
      });
    }
  };

  const pollDiscussions = async (watch: Watch, cursor: WatchCursor, out: NewEvent[]): Promise<void> => {
    const page = await graphql(watch, DISCUSSIONS_QUERY);
    if (!page) return;
    const { fresh, next } = above(asArray(page.nodes), (node) => num(node.number), cursor.discussion);
    cursor.discussion = next;
    for (const node of fresh) {
      out.push({
        type: "discussion-opened",
        title: clip(`Discussion #${num(node.number)} ${String(node.title ?? "")}`, 160),
        fields: {
          number: String(num(node.number)),
          author: login(node.author),
          category: String(record(node.category).name ?? ""),
          url: String(node.url ?? ""),
          text: clip(node.body, TEXT_MAX),
        },
      });
    }
  };

  const pollDiscussionComments = async (watch: Watch, cursor: WatchCursor, out: NewEvent[]): Promise<void> => {
    const page = await graphql(watch, DISCUSSION_COMMENTS_QUERY);
    if (!page) return;
    const comments = asArray(page.nodes).flatMap((discussion) =>
      asArray(record(discussion.comments).nodes).map((comment) => ({ comment, discussion })));
    const { fresh, next } = above(comments, ({ comment }) => num(comment.databaseId), cursor.discussionComment);
    cursor.discussionComment = next;
    for (const { comment, discussion } of fresh.slice(-MAX_ITEMS_PER_FEED)) {
      const author = login(comment.author);
      out.push({
        type: "discussion-comment",
        title: clip(`Comment${author ? ` by ${author}` : ""} on discussion #${num(discussion.number)} ${String(discussion.title ?? "")}`, 160),
        fields: { number: String(num(discussion.number)), author, url: String(comment.url ?? ""), text: clip(comment.body, TEXT_MAX) },
      });
    }
  };

  const POLL: Record<Feed, (watch: Watch, cursor: WatchCursor, out: NewEvent[]) => Promise<void>> = {
    push: pollPush,
    issues: pollIssues,
    comments: pollComments,
    releases: pollReleases,
    discussions: pollDiscussions,
    discussionComments: pollDiscussionComments,
  };

  /** Group active wakes into watches: one per account and repository. */
  const watchesOf = async (subs: AgentEventSubscription[]): Promise<Watch[]> => {
    const watches = new Map<string, Watch>();
    for (const sub of subs) {
      const named = reposOf(sub);
      const targets: Array<{ repo: string; host: string }> = named.length
        ? named.map((repo) => ({ repo, host: "github.com" }))
        : await deps.projectRepo(sub.projectId)
          .then((own) => own && REPO_PATTERN.test(own.repo) ? [{ repo: own.repo.toLowerCase(), host: own.host.toLowerCase() }] : [])
          .catch(() => []);
      if (!targets.length) {
        warnOnce(`${sub.agentId}:${sub.triggerId}|norepo`, `agent ${sub.agentId} wakes on GitHub but names no repository and its project has no GitHub remote`);
        continue;
      }
      for (const target of targets) {
        const access = await deps.access(sub, target.host).catch((error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }));
        if ("refused" in access) {
          warnOnce(`${sub.agentId}:${sub.triggerId}|refused`, `agent ${sub.agentId} cannot watch ${target.repo}: ${access.refused}`);
          continue;
        }
        const key = `${sub.spaceId}|${access.key}|${target.host}/${target.repo}`;
        const watch = watches.get(key) ?? { key, spaceId: sub.spaceId, repo: target.repo, api: access.api, feeds: new Set<Feed>(), subs: [] };
        for (const feed of feedsFor(sub.types)) watch.feeds.add(feed);
        watch.subs.push(sub);
        watches.set(key, watch);
      }
    }
    return [...watches.values()];
  };

  const tick = async (): Promise<number> => {
    const sources = deps.sources();
    const subs = sources?.subscriptions?.(GITHUB_EVENT_SOURCE.id) ?? [];
    if (!sources || !subs.length) return 0;
    const watches = await watchesOf(subs);
    const bySpace = new Map<string, Watch[]>();
    for (const watch of watches) bySpace.set(watch.spaceId, [...bySpace.get(watch.spaceId) ?? [], watch]);
    let published = 0;
    for (const [spaceId, group] of bySpace) {
      let cursors: Record<string, WatchCursor>;
      try { cursors = deps.load(spaceId); } catch { cursors = {}; }
      for (const watch of group) {
        const cursor: WatchCursor = { ...cursors[watch.key] };
        const out: NewEvent[] = [];
        const graphqlDue = now() - (graphqlAt.get(watch.key) ?? -Infinity) >= graphqlEveryMs;
        for (const feed of FEEDS) {
          if (!watch.feeds.has(feed)) continue;
          if (GRAPHQL_FEEDS.has(feed) && !graphqlDue) continue;
          try {
            await POLL[feed](watch, cursor, out);
          } catch (error) {
            warnOnce(`${watch.key}|${feed}|error`, `repository watch ${watch.repo} (${feed}): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if ([...watch.feeds].some((feed) => GRAPHQL_FEEDS.has(feed)) && graphqlDue) graphqlAt.set(watch.key, now());
        cursor.usedAt = now();
        cursors[watch.key] = cursor;
        for (const event of out) {
          for (const sub of watch.subs) {
            if (!sub.types.includes(event.type)) continue;
            const publication: AgentEventPublication = {
              source: GITHUB_EVENT_SOURCE.id,
              type: event.type,
              spaceId: sub.spaceId,
              projectId: sub.projectId,
              title: event.title,
              fields: { ...event.fields, repo: watch.repo },
              target: { agentId: sub.agentId, triggerId: sub.triggerId },
            };
            sources.publish(publication);
            published += 1;
          }
        }
      }
      for (const [key, cursor] of Object.entries(cursors)) {
        if (now() - (cursor.usedAt ?? 0) > STALE_MS) delete cursors[key];
      }
      try { deps.save(spaceId, cursors); } catch (error) {
        warnOnce(`${spaceId}|save`, `repository watch state not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return published;
  };

  return {
    tick: async () => {
      if (running) return 0;
      running = true;
      try { return await tick(); } finally { running = false; }
    },
    start(everyMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => { void this.tick().catch((error: unknown) => warn(`repository watch failed: ${error instanceof Error ? error.message : String(error)}`)); }, everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      etags.clear();
      graphqlAt.clear();
    },
  };
}

/** Cursors in a Space's package directory, `repo-watch.json`. */
export function createRepoWatchFileStore(dirFor: (spaceId: string) => string): Pick<GithubRepoWatchDeps, "load" | "save"> {
  return {
    load(spaceId) {
      try {
        const parsed = JSON.parse(readFileSync(join(dirFor(spaceId), "repo-watch.json"), "utf8")) as unknown;
        return record(parsed) as Record<string, WatchCursor>;
      } catch {
        return {};
      }
    },
    save(spaceId, cursors) {
      const dir = dirFor(spaceId);
      mkdirSync(dir, { recursive: true });
      atomicWriteSync(join(dir, "repo-watch.json"), `${JSON.stringify(cursors)}\n`);
    },
  };
}
