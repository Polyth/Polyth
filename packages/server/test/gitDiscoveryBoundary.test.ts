import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { bindGitDiscoveryToDataDir } from "../src/gitDiscoveryBoundary.ts";

const toplevel = (cwd: string, env: NodeJS.ProcessEnv): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

test("a project in a data directory inside a checkout does not inherit that repository", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "polyth-git-boundary-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_CEILING_DIRECTORIES;
  execFileSync("git", ["init", "-q", root], { env });
  const dataDir = join(root, "data");
  const project = join(dataDir, "spaces", "space-a", "projects", "project-a");
  const ownRepository = join(dataDir, "spaces", "space-a", "projects", "project-b");
  const ownSubfolder = join(ownRepository, "src");
  const checkoutSubfolder = join(root, "packages", "feature");
  for (const path of [project, ownSubfolder, checkoutSubfolder]) mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", ownRepository], { env });

  assert.equal(toplevel(project, env), root, "the fixture reproduces upward discovery");

  bindGitDiscoveryToDataDir(dataDir, env);

  assert.equal(toplevel(project, env), null);
  assert.equal(toplevel(ownRepository, env), ownRepository);
  assert.equal(toplevel(ownSubfolder, env), ownRepository);
  assert.equal(toplevel(checkoutSubfolder, env), root, "a project in a checkout subfolder keeps its repository");
  assert.equal(toplevel(dataDir, env), root, "the data directory itself is not excluded");
});

test("the boundary keeps an operator's ceilings and is added once", () => {
  const env: NodeJS.ProcessEnv = {};
  bindGitDiscoveryToDataDir("/srv/data", env);
  assert.equal(env.GIT_CEILING_DIRECTORIES, "/srv/data");
  bindGitDiscoveryToDataDir("/srv/data", env);
  assert.equal(env.GIT_CEILING_DIRECTORIES, "/srv/data");

  const operator: NodeJS.ProcessEnv = { GIT_CEILING_DIRECTORIES: "/home/operator" };
  bindGitDiscoveryToDataDir("/srv/data", operator);
  assert.equal(operator.GIT_CEILING_DIRECTORIES, `/home/operator${delimiter}/srv/data`);
});
