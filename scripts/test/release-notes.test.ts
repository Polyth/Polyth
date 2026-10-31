import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  classifyCommit,
  collectCommits,
  commitSummary,
  pickBaseRelease,
  releaseMarker,
  releaseSource,
  releaseTitle,
  renderReleaseNotes,
  summarizeContributors,
} from "../ci/release-notes.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, body: "", published_at: "2026-10-10T03:00:00Z", ...extra });

test("each channel measures its changes from the right previous release", () => {
  const releases = [
    release("v0.1.130"), release("v0.1.135-beta"), release("v0.1.136-nightly"),
    release("v0.1.137-nightly"), release("v0.1.138"), release("v0.1.139-beta", { draft: true }), release("v0.1.150-nightly"),
  ];
  assert.equal(pickBaseRelease(releases, "nightly", "0.1.140-nightly")?.tag_name, "v0.1.137-nightly");
  // Test notes count from the newest test or stable release.
  assert.equal(pickBaseRelease(releases, "test", "0.1.140-beta")?.tag_name, "v0.1.138");
  assert.equal(pickBaseRelease(releases, "stable", "0.1.140")?.tag_name, "v0.1.138");
  assert.equal(pickBaseRelease(releases, "stable", "0.1.131")?.tag_name, "v0.1.130");
  assert.equal(pickBaseRelease(releases, "stable", "0.1.129"), null);
  // A channel's first release counts from the newest older release of any channel.
  assert.equal(pickBaseRelease([release("v0.1.137"), release("v0.1.139-beta")], "nightly", "0.1.140-nightly")?.tag_name, "v0.1.139-beta");
});

test("the hidden marker records the exact source", () => {
  const body = `notes\n\n${releaseMarker("nightly", SHA)}\n`;
  assert.equal(releaseSource(body), SHA);
  assert.equal(releaseSource("no marker"), null);
  assert.equal(releaseTitle("nightly", "0.1.140-nightly"), "Polyth 0.1.140 · Nightly");
  assert.equal(releaseTitle("stable", "0.1.141"), "Polyth 0.1.141 · Stable");
});

test("commits group by conventional type, leading verb and touched paths", () => {
  const cases: Array<[string, string[], string, string]> = [
    ["feat(web): add view tabs", ["apps/web/src/a.tsx"], "features", "Add view tabs"],
    ["fix(desktop): keep the window on top.", ["apps/desktop/src/main.ts"], "fixes", "Keep the window on top"],
    ["Add a cost-aware delegation skill", [".agents/skills/delegate/SKILL.md"], "maintenance", "Add a cost-aware delegation skill"],
    ["Stop \"Fetch is aborted\" toasts", ["apps/web/src/a.ts", "apps/web/test/a.test.ts"], "fixes", "Stop \"Fetch is aborted\" toasts"],
    ["Make phone motion follow the finger", ["apps/web/src/a.ts"], "improvements", "Make phone motion follow the finger"],
    ["Type the helper result", ["apps/web/src/a.ts"], "maintenance", "Type the helper result"],
    ["Додай перемикач каналу", ["apps/web/src/a.ts"], "features", "Додай перемикач каналу"],
    ["Виправити падіння", ["apps/web/src/a.ts"], "fixes", "Виправити падіння"],
    ["ci: pin node", [".github/workflows/ci.yml"], "maintenance", "Pin node"],
    ["perf(server): batch reads", ["packages/server/src/a.ts"], "improvements", "Batch reads"],
  ];
  for (const [subject, files, section, title] of cases) {
    assert.deepEqual(classifyCommit({ subject, files }), { section, title }, subject);
  }
});

test("the summary is the body's first sentence without trailers", () => {
  assert.equal(commitSummary("Swipes track the finger. Menus animate out.\n\nMore.\n\nCo-Authored-By: Claude <noreply@anthropic.com>"), "Swipes track the finger.");
  assert.equal(commitSummary("Co-Authored-By: Claude <noreply@anthropic.com>"), "");
  assert.equal(commitSummary("Started by session 9fdb0279; narrowed here."), "");
  const long = commitSummary(`${"word ".repeat(80)}end.`);
  assert.ok(long.length <= 221 && long.endsWith("…"), long);
});

test("contributors merge identities and credit AI agents separately", () => {
  const commit = (sha: string, name: string, email: string, coAuthors: Array<{ name: string; email: string }> = []) =>
    ({ sha, subject: "x", body: "", files: [], author: { name, email }, coAuthors });
  const { people, agents } = summarizeContributors([
    commit("a", "Max", "max@polyth.app", [{ name: "Claude Opus 5.5", email: "noreply@anthropic.com" }]),
    commit("b", "Max", "78844585+devmaxer@users.noreply.github.com", [{ name: "Claude Opus 5.5", email: "noreply@anthropic.com" }]),
    commit("c", "Max", "max@polyth.top"),
    commit("d", "Grace Hopper", "grace@example.com", [{ name: "Ada", email: "ada@example.com" }]),
    commit("e", "Cursor Agent", "cursoragent@cursor.com", [{ name: "Max", email: "max@polyth.app" }]),
    commit("f", "polyth-blueprint-bot", "actions@users.noreply.github.com"),
    commit("g", "dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com"),
  ]);
  assert.deepEqual(people, [
    { name: "Max", login: "devmaxer", commits: 4 },
    { name: "Ada", login: null, commits: 1 },
    { name: "Grace Hopper", login: null, commits: 1 },
  ]);
  assert.deepEqual(agents, [{ name: "Claude Opus 5.5", commits: 2 }, { name: "Cursor Agent", commits: 1 }]);
});

test("notes are collected from the marked source range and rendered by section", () => {
  const repo = mkdtempSync(join(tmpdir(), "release-notes-"));
  const run = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (subject: string, file: string, body = "", author = "Max <max@polyth.app>") => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), `${subject}\n`);
    run("add", "-A");
    run("-c", "user.name=Max", "-c", "user.email=max@polyth.app", "commit", "-q", "--author", author, "-m", subject, ...(body ? ["-m", body] : []));
    return run("rev-parse", "HEAD");
  };
  try {
    run("init", "-q");
    writeFileSync(join(repo, ".mailmap"), "Max <78844585+devmaxer@users.noreply.github.com> <max@polyth.app>\nMax <78844585+devmaxer@users.noreply.github.com> devmaxer <max@polyth.top>\n");
    const first = commit("Add the first thing", "apps/web/src/a.ts");
    commit("Add view tabs to the header", "apps/web/src/tabs.ts", "Tabs sit in the header. They scroll.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
    commit("fix(desktop): keep updates on the chosen channel", "apps/desktop/src/main.ts", "Co-Authored-By: devmaxer <max@polyth.top>", "Ada <ada@example.com>");
    commit("Document the channels", "docs/operations/releases.md");
    commit("WIP checkpoint", "apps/web/src/b.ts");

    const base = release("v0.1.137", { body: `old\n${releaseMarker("stable", first)}` });
    const { commits, basis, source } = collectCommits(repo, { base });
    assert.equal(basis, "range");
    assert.deepEqual(commits.map((entry: { subject: string }) => entry.subject), [
      "Document the channels", "fix(desktop): keep updates on the chosen channel", "Add view tabs to the header",
    ]);
    const notes = renderReleaseNotes({
      channel: "test", version: "0.1.140-beta", commits, base, basis, source,
      repository: "o/r", date: new Date("2026-10-14T12:00:00Z"),
    });
    assert.match(notes, /^\*\*Test\*\* · 14 October 2026 · built from `[0-9a-f]{9}`/);
    assert.match(notes, /\*\*3 changes\*\* since \[v0\.1\.137\]\(https:\/\/github\.com\/o\/r\/releases\/tag\/v0\.1\.137\)\./);
    assert.match(notes, /### ✨ New\n\n- \*\*Add view tabs to the header\*\*\n  <br><sub>Tabs sit in the header\.<\/sub>/);
    assert.match(notes, /### 🐛 Fixes\n\n- \*\*Keep updates on the chosen channel\*\*\n/);
    assert.match(notes, /<summary><strong>🧰 Under the hood<\/strong> \(1\)<\/summary>\n\n- Document the channels/);
    // .mailmap applies to authors and co-authors, turning Max into an @-mention.
    assert.match(notes, /Thank you to @devmaxer \(3 commits\) and \*\*Ada\*\* \(1 commit\)\./);
    assert.match(notes, /Paired with AI agents: Claude Opus 5\.5 \(1\)\./);
    assert.equal(releaseSource(notes), source);

    // A marker that is not an ancestor (rewritten history) falls back to the publication date.
    const stale = release("v0.1.137", { body: releaseMarker("stable", SHA), published_at: "2000-01-01T00:00:00Z" });
    assert.equal(collectCommits(repo, { base: stale }).basis, "date");
    assert.equal(collectCommits(repo, {}).basis, "recent");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
