#!/usr/bin/env node
// Release notes for the external builder's GitHub Releases (see
// docs/operations/releases.md, "Release channels"). The builder's publish job
// runs, inside a source checkout with full commit history:
//
//   node scripts/ci/release-notes.mjs --channel <stable|test|nightly> \
//     --version <X.Y.N[-id]> --releases <releases.json> --out <notes.md> [--head <rev>]
//
// releases.json is the builder repository's `GET /releases` response. The
// previous release of the channel is the newest older version the channel
// would update from; its hidden source marker gives the exact commit range.
// Commits are grouped into New / Improvements / Fixes / Under the hood, and
// every human and AI contributor (authors and Co-authored-by trailers) is
// credited. Writes `title=` to $GITHUB_OUTPUT when set.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { channelOfVersion, resolveReleaseChannel } from "./update-feed.mjs";

/** Releases whose changes a channel's notes are measured from. */
const BASE_CHANNELS = { stable: ["stable"], test: ["test", "stable"], nightly: ["nightly"] };
const CHANNEL_LABELS = { stable: "Stable", test: "Test", nightly: "Nightly" };
const CHANNEL_BLURBS = {
  stable: "The recommended build for everyone, promoted by hand once it has been tested.",
  test: "A release candidate, published by hand for testing before it goes stable. Installs on the Test channel also receive stable releases.",
  nightly: "Built automatically every morning from the newest code. Expect rough edges.",
};
const SOURCE_MARKER = /<!--\s*polyth-release:[^>]*\bsource=([0-9a-f]{40})\b[^>]*-->/;
/** Without a usable previous release, look back this far. */
const FALLBACK_COMMITS = 50;
const SECTION_LIMIT = 80;
const SUMMARY_LIMIT = 220;

export const SECTIONS = [
  { key: "features", title: "✨ New" },
  { key: "improvements", title: "🚀 Improvements" },
  { key: "fixes", title: "🐛 Fixes" },
  { key: "maintenance", title: "🧰 Under the hood", collapsed: true },
];

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const CONVENTIONAL_SECTIONS = {
  feat: "features", feature: "features",
  fix: "fixes", hotfix: "fixes",
  perf: "improvements", i18n: "improvements", ux: "improvements", ui: "improvements", style: "improvements",
  docs: "maintenance", doc: "maintenance", test: "maintenance", tests: "maintenance", ci: "maintenance",
  build: "maintenance", chore: "maintenance", refactor: "maintenance", revert: "maintenance", deps: "maintenance",
};
const VERB_SECTIONS = [
  ["features", /^(add|adds|added|introduce|introduces|support|supports|implement|implements|create|creates|enable|enables|offer|offers|ship|ships|launch|new|дода\S*|додай)$/i],
  ["fixes", /^(fix|fixes|fixed|stop|stops|prevent|prevents|repair|restore|restores|resolve|resolves|correct|avoid|recover|unblock|guard|keep|keeps|don't|never|handle|виправ\S*)$/i],
  ["maintenance", /^(document|documents|docs|test|tests|type|types|refactor|rename|move|extract|bump|pin|upgrade|lint|format|tidy|revert|clean|cleanup|перевір\S*|ci|chore)$/i],
];
/** A commit touching only these paths is maintenance whatever its subject says. */
const MAINTENANCE_PATH = /(^|\/)(docs?|tests?|__tests__|\.agents|\.github|\.claude|\.pi)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.md$|^AGENTS\.md$|^scripts\/test\//;
const NOISE_SUBJECT = /^(wip\b|fixup!|squash!|amend!|merge (branch|remote-tracking|pull request|origin))/i;

const AI_EMAILS = new Set(["noreply@anthropic.com", "cursoragent@cursor.com", "noreply@opencode.ai", "noreply@openai.com", "noreply@google.com"]);
const AI_NAMES = /^(claude|codex|gpt|chatgpt|openai|gemini|copilot|cursor\b|cursor agent|opencode|devin|aider|sweep|jules|amp\b|pi agent)/i;
const BOT = /\[bot\]$|^(actions|github-actions)@|@localhost$|^noreply@github\.com$|^(dependabot|renovate)/i;
const NOREPLY_LOGIN = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`Bad argument near ${JSON.stringify(key)}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function versionParts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Numeric X.Y.N order. Run numbers are unique across channels, so the prerelease id never decides. */
export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) throw new Error(`Cannot compare ${a} and ${b}`);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

/**
 * The newest published release older than `version` that `channel` measures
 * its changes from; the first release of a channel counts from the newest
 * older release of any channel.
 */
export function pickBaseRelease(releases, channel, version) {
  const newest = (accepted) => {
    let best = null;
    for (const release of releases ?? []) {
      if (release?.draft || typeof release?.tag_name !== "string") continue;
      const tagVersion = release.tag_name.replace(/^v/, "");
      const tagChannel = channelOfVersion(tagVersion);
      if (!tagChannel || !accepted.includes(tagChannel) || compareVersions(tagVersion, version) >= 0) continue;
      if (!best || compareVersions(tagVersion, best.tag_name) > 0) best = release;
    }
    return best;
  };
  return newest(BASE_CHANNELS[resolveReleaseChannel(channel)]) ?? newest(Object.keys(BASE_CHANNELS));
}

export function releaseSource(body) {
  return SOURCE_MARKER.exec(body ?? "")?.[1] ?? null;
}

export function releaseMarker(channel, source) {
  return `<!-- polyth-release: channel=${channel} source=${source} -->`;
}

export function parseCoAuthors(body) {
  const people = [];
  for (const match of (body ?? "").matchAll(/^co-authored-by:\s*(.+?)\s*<([^>\s]+)>\s*$/gim)) {
    people.push({ name: match[1], email: match[2] });
  }
  return people;
}

/** Commit message body without trailers and with the first paragraph's first sentence as the summary. */
export function commitSummary(body) {
  const text = (body ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^[A-Za-z-]+:\s+\S.*<[^>]+>\s*$/.test(line) && !/^(signed-off-by|change-id):/i.test(line))
    .join("\n")
    .trim();
  const paragraph = text.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!paragraph || /^started by session\b/i.test(paragraph)) return "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(paragraph)?.[1] ?? paragraph;
  if (sentence.length <= SUMMARY_LIMIT) return sentence;
  const cut = sentence.slice(0, SUMMARY_LIMIT);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), SUMMARY_LIMIT - 40)).replace(/[,;:\s]+$/, "")}…`;
}

/** { section, title } for a commit: conventional type, then leading verb, then the paths it touched. */
export function classifyCommit(commit) {
  let subject = commit.subject.trim();
  let section = null;
  const conventional = CONVENTIONAL.exec(subject);
  if (conventional && Object.hasOwn(CONVENTIONAL_SECTIONS, conventional[1].toLowerCase())) {
    section = CONVENTIONAL_SECTIONS[conventional[1].toLowerCase()];
    subject = conventional[4].trim();
  }
  if (!section) {
    const verb = subject.split(/\s+/)[0]?.replace(/[:,]$/, "") ?? "";
    section = VERB_SECTIONS.find(([, pattern]) => pattern.test(verb))?.[0] ?? "improvements";
  }
  const files = commit.files ?? [];
  if (files.length > 0 && files.every((file) => MAINTENANCE_PATH.test(file))) section = "maintenance";
  const title = subject.charAt(0).toUpperCase() + subject.slice(1).replace(/\.$/, "");
  return { section, title };
}

function identityKind(person) {
  const email = person.email.toLowerCase();
  if (BOT.test(person.name) || BOT.test(email)) return "bot";
  if (AI_EMAILS.has(email) || AI_NAMES.test(person.name)) return "agent";
  return "human";
}

/**
 * Humans and AI agents credited by the commits, most active first. Human
 * identities sharing an email or exact name are one person (the repository
 * .mailmap applies to authors first); a GitHub noreply address becomes an
 * @mention. Each commit counts once per contributor.
 */
export function summarizeContributors(commits) {
  const people = [];
  const byKey = new Map();
  const agents = new Map();
  const personFor = (identity) => {
    const keys = [`e:${identity.email.toLowerCase()}`, `n:${identity.name.trim().toLowerCase()}`];
    const found = [...new Set(keys.map((key) => byKey.get(key)).filter(Boolean))];
    let person = found[0];
    if (!person) {
      person = { names: new Map(), logins: new Set(), commits: new Set() };
      people.push(person);
    }
    for (const other of found.slice(1)) {
      for (const [name, count] of other.names) person.names.set(name, (person.names.get(name) ?? 0) + count);
      for (const login of other.logins) person.logins.add(login);
      for (const sha of other.commits) person.commits.add(sha);
      people.splice(people.indexOf(other), 1);
      for (const [key, value] of byKey) if (value === other) byKey.set(key, person);
    }
    for (const key of keys) byKey.set(key, person);
    return person;
  };
  for (const commit of commits) {
    for (const identity of [commit.author, ...(commit.coAuthors ?? [])]) {
      if (!identity?.name || !identity.email) continue;
      const kind = identityKind(identity);
      if (kind === "bot") continue;
      if (kind === "agent") {
        const agent = agents.get(identity.name) ?? new Set();
        agent.add(commit.sha);
        agents.set(identity.name, agent);
        continue;
      }
      const person = personFor(identity);
      person.names.set(identity.name, (person.names.get(identity.name) ?? 0) + 1);
      const login = NOREPLY_LOGIN.exec(identity.email)?.[1];
      if (login) person.logins.add(login);
      person.commits.add(commit.sha);
    }
  }
  const byActivity = (a, b) => b.commits - a.commits || a.name.localeCompare(b.name);
  return {
    people: people.map((person) => ({
      name: [...person.names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      login: [...person.logins].sort()[0] ?? null,
      commits: person.commits.size,
    })).sort(byActivity),
    agents: [...agents].map(([name, shas]) => ({ name, commits: shas.size })).sort(byActivity),
  };
}

function git(cwd, args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result;
}

export function parseGitLog(output) {
  return output.split("\x1e").filter((chunk) => chunk.trim()).map((chunk) => {
    const [header, fileList = ""] = chunk.split("\x1d");
    const [sha, authorName, authorEmail, subject, body] = header.replace(/^\s+/, "").split("\x1f");
    return {
      sha, subject, body,
      author: { name: authorName, email: authorEmail },
      coAuthors: parseCoAuthors(body),
      files: fileList.split("\n").map((line) => line.trim()).filter(Boolean),
    };
  });
}

/** `git log --use-mailmap` maps authors only; map Co-authored-by identities through .mailmap too. */
function applyMailmap(repoDir, commits) {
  const identities = [...new Set(commits.flatMap((commit) => commit.coAuthors.map((person) => `${person.name} <${person.email}>`)))];
  if (identities.length === 0) return commits;
  const result = git(repoDir, ["check-mailmap", ...identities], true);
  if (result.status !== 0) return commits;
  const mapped = new Map(result.stdout.split("\n").filter(Boolean).map((line, index) => [identities[index], line]));
  for (const commit of commits) {
    commit.coAuthors = commit.coAuthors.map((person) => {
      const match = /^(.*?)\s*<([^>]+)>$/.exec(mapped.get(`${person.name} <${person.email}>`) ?? "");
      return match ? { name: match[1], email: match[2] } : person;
    });
  }
  return commits;
}

/**
 * Commits since the base release. An exact source marker gives `base..head`;
 * otherwise (first release of a channel, history rewritten) fall back to the
 * base's publication date, then to the newest FALLBACK_COMMITS.
 */
export function collectCommits(repoDir, { head = "HEAD", base = null } = {}) {
  const from = releaseSource(base?.body);
  let range;
  let basis;
  if (from && git(repoDir, ["merge-base", "--is-ancestor", from, head], true).status === 0) {
    range = [`${from}..${head}`];
    basis = "range";
  } else if (base?.published_at) {
    range = [`--since=${base.published_at}`, head];
    basis = "date";
  } else {
    range = [`--max-count=${FALLBACK_COMMITS}`, head];
    basis = "recent";
  }
  const output = git(repoDir, [
    "-c", "core.quotepath=off", "log", "--no-merges", "--no-renames", "--use-mailmap", "--name-only",
    "--format=%x1e%H%x1f%aN%x1f%aE%x1f%s%x1f%b%x1d", ...range,
  ]).stdout;
  const seen = new Set();
  const commits = applyMailmap(repoDir, parseGitLog(output)).filter((commit) => {
    if (NOISE_SUBJECT.test(commit.subject) || seen.has(commit.subject)) return false;
    seen.add(commit.subject);
    return true;
  });
  const source = git(repoDir, ["rev-parse", head]).stdout.trim();
  return { commits, basis, source };
}

function escapeMarkdown(text) {
  return text.replace(/([\\`*_<>[\]|])/g, "\\$1");
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Kyiv" }).format(date);
}

function formatList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function releaseTitle(channel, version) {
  const label = CHANNEL_LABELS[resolveReleaseChannel(channel)];
  return `Polyth ${version.replace(/-.*$/, "")} · ${label}`;
}

/** The GitHub Release body. */
export function renderReleaseNotes({ channel, version, commits, base, basis, source, repository, date = new Date() }) {
  const releaseChannel = resolveReleaseChannel(channel);
  const lines = [];
  lines.push(`**${CHANNEL_LABELS[releaseChannel]}** · ${formatDate(date)} · built from \`${source.slice(0, 9)}\``, "");
  lines.push(`> ${CHANNEL_BLURBS[releaseChannel]}`, "");
  const baseLink = base
    ? (repository ? `[${base.tag_name}](https://github.com/${repository}/releases/tag/${base.tag_name})` : base.tag_name)
    : null;
  if (commits.length === 0) {
    lines.push(base ? `No code changes since ${baseLink}; this build repackages the same source.` : "No code changes found for this build.", "");
  } else {
    const since = !base
      ? "in the latest history"
      : basis === "range" ? `since ${baseLink}` : `since ${baseLink} was published`;
    lines.push(`**${plural(commits.length, "change")}** ${since}.`, "");
  }

  const grouped = new Map(SECTIONS.map((section) => [section.key, []]));
  for (const commit of commits) {
    const { section, title } = classifyCommit(commit);
    grouped.get(section).push({ title, summary: commitSummary(commit.body) });
  }
  for (const section of SECTIONS) {
    const entries = grouped.get(section.key);
    if (entries.length === 0) continue;
    const shown = entries.slice(0, SECTION_LIMIT);
    const body = shown.flatMap((entry) => entry.summary && !section.collapsed
      ? [`- **${escapeMarkdown(entry.title)}**`, `  <br><sub>${escapeMarkdown(entry.summary)}</sub>`]
      : [`- ${section.collapsed ? escapeMarkdown(entry.title) : `**${escapeMarkdown(entry.title)}**`}`]);
    if (entries.length > shown.length) body.push(`- …and ${entries.length - shown.length} more`);
    if (section.collapsed) {
      lines.push("<details>", `<summary><strong>${section.title}</strong> (${entries.length})</summary>`, "", ...body, "", "</details>", "");
    } else {
      lines.push(`### ${section.title}`, "", ...body, "");
    }
  }

  const { people, agents } = summarizeContributors(commits);
  if (people.length > 0 || agents.length > 0) {
    lines.push("### 💜 Contributors", "");
    if (people.length > 0) {
      const names = people.map((person) => `${person.login ? `@${person.login}` : `**${escapeMarkdown(person.name)}**`} (${plural(person.commits, "commit")})`);
      lines.push(`Thank you to ${formatList(names)}.`, "");
    }
    if (agents.length > 0) {
      const names = agents.map((agent) => `${escapeMarkdown(agent.name)} (${agent.commits})`);
      lines.push(`Paired with AI agents: ${formatList(names)}.`, "");
    }
  }
  lines.push(releaseMarker(releaseChannel, source));
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const channel = resolveReleaseChannel(args.channel);
    if (!args.version || !args.out) throw new Error("--version and --out are required");
    if (channelOfVersion(args.version) !== channel) throw new Error(`Version ${args.version} does not belong to the ${channel} channel`);
    const releases = args.releases ? JSON.parse(readFileSync(args.releases, "utf8")) : [];
    const base = pickBaseRelease(releases, channel, args.version);
    const { commits, basis, source } = collectCommits(resolve(args.repo ?? "."), { head: args.head ?? "HEAD", base });
    const notes = renderReleaseNotes({ channel, version: args.version, commits, base, basis, source, repository: process.env.GITHUB_REPOSITORY });
    writeFileSync(args.out, notes);
    const title = releaseTitle(channel, args.version);
    console.log(`release-notes: ${title}, ${commits.length} commits (${basis}${base ? ` from ${base.tag_name}` : ""})`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `title=${title}\n`);
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
