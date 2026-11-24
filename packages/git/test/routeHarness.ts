// Shared harness for the branch/checkout route tests: a real temp repository,
// the real Git service and a fake sessions service.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectService, SessionService } from "@polyth/contracts";
import { gitRoutes } from "../src/serverEntry.ts";
import { createGitService } from "../src/index.ts";

export interface FakeSession {
  id: string;
  projectId: string;
  status: string;
  spaceId?: string;
  worktreePath?: string;
  branch?: string;
  updatedAt?: number;
  parentId?: string;
  sharing?: { access: string };
  isolation?: { kind: string; worktreePath: string };
  runtimeBinding?: unknown;
  workspace?: { revision: number; repositories: unknown[] };
}

export const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

export function tempRepo(dirs: string[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "polyth-branchux-")));
  dirs.push(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.email", "t@example.com");
  gitIn(dir, "config", "user.name", "Test");
  gitIn(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "init");
  return dir;
}

export const cleanup = (dirs: string[]): void => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
};

export function branchRouteHarness(root: string, sessions: FakeSession[]) {
  const changed: string[] = [];
  const queued = new Set<string>();
  const rebound: Array<{ id: string; input: Record<string, unknown> }> = [];
  const renamed: Array<{ id: string; input: Record<string, unknown> }> = [];
  const routes = gitRoutes({
    projects: { get: async (id: string) => (id === "p1" ? { id, path: root, name: id } : undefined) } as unknown as ProjectService,
    sessions: {
      list: async () => sessions,
      snapshot: async (id: string) => sessions.find((session) => session.id === id),
      queueList: async (id: string) => (queued.has(id) ? [{ id: "q" }] : []),
      markWorktreeMissing: async () => undefined,
      rebindWorkspace: async (id: string, input: Record<string, unknown>) => {
        const target = sessions.find((session) => session.id === id)!;
        const revision = target.workspace?.revision ?? 0;
        if (input.expectedWorkspaceRevision !== undefined && input.expectedWorkspaceRevision !== revision) {
          throw Object.assign(new Error("workspace revision is stale"), { code: "conflict" });
        }
        if (input.worktreePath === null) delete target.worktreePath;
        else if (typeof input.worktreePath === "string") target.worktreePath = input.worktreePath;
        if (input.branch === null) delete target.branch;
        else if (typeof input.branch === "string") target.branch = input.branch;
        target.workspace = { revision: revision + 1, repositories: target.workspace?.repositories ?? [] };
        rebound.push({ id, input });
        return target;
      },
      renameWorktreeBranch: async (id: string, input: Record<string, unknown>) => {
        renamed.push({ id, input });
        const target = sessions.find((session) => session.id === id);
        if (target) target.branch = String(input.to);
        return target;
      },
    } as unknown as SessionService,
    scopedSessions: ((space: { spaceId: string }) => ({
      snapshot: async (id: string) => {
        const row = sessions.find((session) => session.id === id);
        if (!row || (row.spaceId !== undefined && row.spaceId !== space.spaceId)) {
          throw Object.assign(new Error("session not found"), { code: "not-found" });
        }
        return row;
      },
    })) as never,
    git: createGitService(),
    commitMessage: async () => "",
    worktreesChanged: (projectId) => changed.push(projectId),
  });
  const post = async (path: string, payload: Record<string, unknown>, spaceId = "sp1") => {
    let status = 0;
    let body: Record<string, unknown> = {};
    await routes({
      req: {}, res: {},
      space: { userId: "usr_test", spaceId },
      url: new URL(`http://x${path}`), path, method: "POST",
      body: async () => payload,
      json: (code: number, data: Record<string, unknown>) => { status = code; body = data; },
    } as never);
    return { status, body };
  };
  return { post, changed, renamed, rebound, queued };
}
