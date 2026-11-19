// A GitHub Actions run as a `polyth_wait` condition. The wait package defines
// the contract and exposes `wait.conditions`; this file only mirrors its
// shape structurally, so GitHub works without the wait package and the wait
// package never names GitHub.
import type { Disposable, JsonObject } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { runGh, withGithubAuth, type ExecFn } from "./index.ts";
import type { GithubAccessDecision } from "./prWatch.ts";

export interface WaitConditionContextShape { spaceId: string; projectId: string; sessionId: string; actorUserId: string; cwd: string }
export interface WaitConditionRecordShape {
  spaceId: string; projectId: string; actorUserId: string; id: string; label: string; target: JsonObject;
}
export type WaitConditionPollShape = { done: false } | { done: true; outcome: string; text: string };
export interface WaitConditionProviderShape {
  kind: "github_run";
  intervalMs: number;
  start(input: JsonObject, ctx: WaitConditionContextShape): Promise<{ label: string; target: JsonObject }>;
  poll(record: WaitConditionRecordShape): Promise<WaitConditionPollShape>;
}
/** The `wait.conditions` service, as far as GitHub uses it. */
export interface WaitConditionRegistryShape { register(provider: WaitConditionProviderShape): Disposable }

export interface GithubRunWaitDeps {
  host: ServerPackageHost;
  remoteHosts(path: string): Promise<string[]>;
  decide(space: import("@polyth/contracts").SpaceContext, hosts: string[]): GithubAccessDecision;
  /** The `gh` runner; tests stub it. */
  exec?: ExecFn;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

interface RunView { status?: string; conclusion?: string; name?: string; url?: string; displayTitle?: string }

export function createGithubRunWaitProvider(deps: GithubRunWaitDeps): WaitConditionProviderShape {
  const { host } = deps;

  /** The person's account for this project, the way a pull request watch decides it. */
  const access = async (spaceId: string, projectId: string, actorUserId: string) => {
    const project = await host.projects.get(projectId);
    if (!project || (project.spaceId && project.spaceId !== spaceId)) return { ok: false, reason: "The project is no longer available." } as const;
    const space = host.personSpaceContext?.(actorUserId, spaceId);
    if (!space) return { ok: false, reason: "The person who started this wait is no longer a member of this Space." } as const;
    const decision = deps.decide(space, await deps.remoteHosts(project.path).catch(() => []));
    if (decision.kind === "refused") return { ok: false, reason: decision.reason || "Your GitHub account is not available here." } as const;
    return { ok: true, cwd: project.path, auth: decision.kind === "personal" ? decision.auth : null } as const;
  };

  const view = async (target: JsonObject, got: Extract<Awaited<ReturnType<typeof access>>, { ok: true }>): Promise<RunView> => {
    const args = ["run", "view", String(target.id), ...(typeof target.repo === "string" ? ["--repo", target.repo] : []),
      "--json", "status,conclusion,name,url,displayTitle"];
    const { stdout } = await withGithubAuth(got.auth, () => runGh(args, got.cwd, deps.exec));
    return JSON.parse(stdout) as RunView;
  };

  return {
    kind: "github_run",
    intervalMs: 45_000,
    async start(input, ctx) {
      const id = input.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw fail("invalid-input", "github_run.id must be a positive integer.");
      if (input.repo !== undefined && (typeof input.repo !== "string" || !REPO.test(input.repo))) throw fail("invalid-input", "github_run.repo must look like owner/name.");
      const got = await access(ctx.spaceId, ctx.projectId, ctx.actorUserId);
      if (!got.ok) throw fail("git-account-required", got.reason);
      const target: JsonObject = { id, ...(typeof input.repo === "string" ? { repo: input.repo } : {}) };
      // The person's own account must reach the run now, not only later.
      const run = await view(target, got).catch(() => { throw fail("not-found", `Your GitHub account cannot reach run ${id}${input.repo ? ` in ${input.repo}` : ""}.`); });
      return { label: `GitHub Actions run #${id}${run.name ? ` "${run.name}"` : ""}`, target };
    },
    async poll(record) {
      const got = await access(record.spaceId, record.projectId, record.actorUserId);
      if (!got.ok) return { done: false };
      const run = await view(record.target, got).catch(() => null);
      if (!run || run.status !== "completed") return { done: false };
      const name = run.name ?? run.displayTitle ?? "";
      return {
        done: true,
        outcome: "completed",
        text: `The GitHub Actions run #${record.target.id}${name ? ` "${name}"` : ""} finished: ${run.conclusion || "no conclusion reported"}.${run.url ? ` ${run.url}` : ""}`,
      };
    },
  };
}
