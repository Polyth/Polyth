import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bodyHasScreenshot, checkPullRequest, noVisibleChangeReason, visibleUiFiles } from "../ci/check-pr-screenshots.mjs";
import {
  ASSETS_BRANCH,
  SECTION_END,
  SECTION_START,
  assetPath,
  collectImages,
  githubSlug,
  imageKind,
  imageUrl,
  pairImages,
  publish,
  screenshotSection,
  upsertSection,
} from "../pr-screenshots.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("images are recognised by their bytes, not their names", () => {
  assert.equal(imageKind(PNG), "png");
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(imageKind(Buffer.from("GIF89a")), "gif");
  assert.equal(imageKind(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(imageKind(Buffer.from("<svg onload=alert(1)>")), null);
});

test("collection walks .scratch, skips symlinks and non-images", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-pr-shots-"));
  try {
    mkdirSync(join(dir, "task", "phone"), { recursive: true });
    mkdirSync(join(dir, "task", "node_modules"), { recursive: true });
    writeFileSync(join(dir, "task", "after.png"), PNG);
    writeFileSync(join(dir, "task", "phone", "before.jpg"), PNG);
    writeFileSync(join(dir, "task", "capture.mjs"), "");
    writeFileSync(join(dir, "task", "node_modules", "x.png"), PNG);
    symlinkSync("/etc/hostname", join(dir, "task", "leak.png"));
    assert.deepEqual(collectImages(dir), ["task/after.png", "task/phone/before.jpg"]);
    assert.deepEqual(collectImages(join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("before/after captures pair per folder and name", () => {
  const { pairs, singles } = pairImages([
    "t/before.png", "t/after.png",
    "t/before-phone.png", "t/after-phone.png",
    "t/sidebar-before.png", "t/sidebar.after.png",
    "t/other/before.png",
    "t/overview.png",
  ]);
  assert.deepEqual(pairs, [
    { before: "t/before.png", after: "t/after.png" },
    { before: "t/before-phone.png", after: "t/after-phone.png" },
    { before: "t/sidebar-before.png", after: "t/sidebar.after.png" },
  ]);
  assert.deepEqual(singles, ["t/other/before.png", "t/overview.png"]);
});

test("the body section renders pairs side by side and is replaced on rerun", () => {
  const section = screenshotSection(["t/before.png", "t/after.png", "t/menu.png"], (name) => `https://x.test/${name}`);
  assert.match(section, /\| Before \| After \|/);
  assert.match(section, /\| !\[t\/before\.png\]\(https:\/\/x\.test\/t\/before\.png\) \| !\[t\/after\.png\]/);
  assert.match(section, /!\[t\/menu\.png\]\(https:\/\/x\.test\/t\/menu\.png\)/);

  const first = upsertSection("## What changes\n\nText.\n", section);
  assert.ok(first.startsWith("## What changes\n\nText.\n\n<!-- polyth:screenshots -->"));
  const again = upsertSection(`${first}\nTrailing note.`, screenshotSection(["t/new.png"], () => "https://x.test/new"));
  assert.equal(again.split(SECTION_START).length, 2);
  assert.ok(!again.includes("menu.png"));
  assert.ok(again.includes("https://x.test/new"));
  assert.ok(again.trimEnd().endsWith("Trailing note."));
  assert.equal(upsertSection("", "S"), "S\n");
  assert.ok(section.endsWith(SECTION_END));
});

test("asset paths and links are safe and pinned to a commit", () => {
  assert.equal(assetPath("polyth/isolate/ab12", "f".repeat(40), "t/after phone (1).png"), `polyth-isolate-ab12/${"f".repeat(12)}-after-phone-1-.png`);
  assert.equal(githubSlug("git@github.com:Polyth/Polyth.git"), "Polyth/Polyth");
  assert.equal(githubSlug("https://github.com/Polyth/Polyth"), "Polyth/Polyth");
  assert.equal(githubSlug("ssh://git@github.com/Polyth/Polyth.git"), "Polyth/Polyth");
  assert.equal(githubSlug("git@gitlab.com:a/b.git"), null);
  assert.equal(imageUrl("O/R", "c0ffee", "b/x y.png"), "https://github.com/O/R/blob/c0ffee/b/x%20y.png?raw=true");
});

test("publishing commits to the assets branch without touching the checkout, and rebuilds on a moved tip", () => {
  const base = mkdtempSync(join(tmpdir(), "polyth-pr-assets-test-"));
  const remote = join(base, "remote.git");
  const repo = join(base, "repo");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "-q", "--bare", remote]);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "feature");
    git(repo, "config", "user.name", "Ada");
    git(repo, "config", "user.email", "ada@example.com");
    git(repo, "remote", "add", "origin", remote);
    writeFileSync(join(repo, "README"), "x\n");
    git(repo, "add", "README");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, "shot.png"), PNG);
    writeFileSync(join(repo, "README"), "dirty\n");
    const indexBefore = git(repo, "diff", "--cached", "--name-only");
    const headBefore = git(repo, "rev-parse", "HEAD");

    const first = publish({ cwd: repo, remote: "origin", branch: "feature", files: [{ absolute: join(repo, "shot.png"), name: "t/shot.png" }] });
    const path = first.paths.get("t/shot.png");
    assert.ok(path?.startsWith("feature/"));
    assert.equal(git(remote, "rev-parse", `refs/heads/${ASSETS_BRANCH}`), first.commit);
    assert.equal(git(remote, "ls-tree", "--name-only", "-r", first.commit), path);
    assert.equal(git(remote, "rev-list", "--count", first.commit), "1");

    assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "feature");
    assert.equal(git(repo, "diff", "--cached", "--name-only"), indexBefore);
    assert.equal(git(repo, "status", "--porcelain", "--", "README"), "M README");

    // Re-publishing the same bytes adds nothing.
    const same = publish({ cwd: repo, remote: "origin", branch: "feature", files: [{ absolute: join(repo, "shot.png"), name: "t/shot.png" }] });
    assert.equal(same.commit, first.commit);

    // Another branch's images land on top of the existing tip.
    writeFileSync(join(repo, "other.png"), Buffer.concat([PNG, Buffer.from([1])]));
    const second = publish({ cwd: repo, remote: "origin", branch: "other", files: [{ absolute: join(repo, "other.png"), name: "o.png" }] });
    assert.equal(git(remote, "rev-parse", `${second.commit}^`), first.commit);
    assert.equal(git(remote, "ls-tree", "--name-only", "-r", second.commit).split("\n").length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the CI check asks visible UI changes for screenshots or a reason", () => {
  const files = ["apps/web/src/styles.css", "packages/git/widgets/Panel.tsx", "packages/git/src/index.ts", "apps/web/test/x.test.tsx", "docs/dev/ui.md"];
  assert.deepEqual(visibleUiFiles(files), ["apps/web/src/styles.css", "packages/git/widgets/Panel.tsx"]);

  const template = "## What changes\n\n<!-- ![x](https://a.test/x.png) -->\n- [ ] Before/after screenshots for a visible UI change\n";
  assert.equal(bodyHasScreenshot(template), false);
  assert.match(checkPullRequest({ body: template, files }) ?? "", /node scripts\/pr-screenshots\.mjs/);

  assert.equal(bodyHasScreenshot("![after](https://github.com/O/R/blob/c/p.png?raw=true)"), true);
  assert.equal(bodyHasScreenshot('<img width="400" src="https://github.com/user-attachments/assets/1">'), true);
  assert.equal(checkPullRequest({ body: "![after](https://x.test/a.png)", files }), null);

  assert.equal(noVisibleChangeReason("No visible change:"), null);
  assert.equal(noVisibleChangeReason("- No visible change: renames a prop"), "renames a prop");
  assert.equal(checkPullRequest({ body: "No visible UI change — test-only refactor", files }), null);

  assert.equal(checkPullRequest({ body: "", files: ["packages/git/src/index.ts"] }), null);
  assert.equal(checkPullRequest({ body: "", files, baseRef: "master", headRef: "devel" }), null);
});
