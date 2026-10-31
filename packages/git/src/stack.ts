import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { Project, SpaceStorage } from "@polyth/contracts";
import { projectRepositories } from "@polyth/contracts/workspace";
import type { GitService } from "./index.ts";
import type { RepoStack, RepoStackInput, RepoStackPreview, RepoStackPreviewEntry, RepoStackApplyResult, RepoStackPushResult } from "./stackTypes.ts";
export type { RepoStack, RepoStackEntry, RepoStackPreview, RepoStackPreviewEntry, RepoStackApplyOutcome, RepoStackApplyResult, RepoStackPushResult } from "./stackTypes.ts";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;
const branchPattern = /^(?!-)(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\.\.$)(?!.*\.lock$)(?!.*@\{)(?:[A-Za-z0-9._/@+-]{1,200})$/;
const stackError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const stackPath = (storage: SpaceStorage): string => storage.path(join("packages", "git", "stacks.json"));
const storageLocks = new Map<string, Promise<void>>();

export async function loadRepoStacks(storage: SpaceStorage): Promise<RepoStack[]> {
  try {
    const value = JSON.parse(await readFile(stackPath(storage), "utf8")) as unknown;
    if (!Array.isArray(value)) throw stackError("storage-unavailable", "repository stack storage is corrupt");
    return value.map((item) => {
      if (!item || typeof item !== "object" || typeof (item as RepoStack).id !== "string" || typeof (item as RepoStack).projectId !== "string" || typeof (item as RepoStack).repositoryId !== "string" || typeof (item as RepoStack).baseBranch !== "string" || !Array.isArray((item as RepoStack).entries)) throw stackError("storage-unavailable", "repository stack storage is corrupt");
      return item as RepoStack;
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function saveRepoStacks(storage: SpaceStorage, stacks: RepoStack[]): Promise<void> {
  const path = stackPath(storage);
  await mkdir(storage.packageDir("git"), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stacks, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

export async function withRepoStackStorageLock<T>(storage: SpaceStorage, fn: () => Promise<T>): Promise<T> {
  const key = stackPath(storage);
  const previous = storageLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  storageLocks.set(key, held);
  await previous;
  try { return await fn(); } finally { release(); if (storageLocks.get(key) === held) storageLocks.delete(key); }
}

/** The browser names branches; only the repository owner resolves commit IDs. */
export async function resolveRepoStackInput(git: GitService, root: string, project: Project, input: RepoStackInput, previous?: RepoStack): Promise<RepoStack> {
  if (!Array.isArray(input.entries) || input.entries.length > 64) throw stackError("invalid-input", "a stack supports up to 64 branches");
  const entries: RepoStack["entries"] = [];
  for (const entry of input.entries) {
    if (!entry || typeof entry !== "object" || !branchPattern.test(entry.branch) || !branchPattern.test(entry.baseBranch)) throw stackError("invalid-input", "invalid stack branch");
    const existing = previous?.entries.find((row) => row.branch === entry.branch);
    const headSha = entry.headSha === undefined ? await git.revParse(root, entry.branch) : existing?.headSha ?? await git.revParse(root, entry.branch);
    const baseSha = existing?.baseSha ?? await git.mergeBase(root, entry.branch, entry.baseBranch);
    if ((entry.headSha !== undefined && entry.headSha !== headSha) || (entry.baseSha !== undefined && entry.baseSha !== baseSha)) throw stackError("conflict", "stack commit snapshots must match the repository or saved stack");
    if (!await git.isAncestor(root, baseSha, headSha)) throw stackError("conflict", "saved stack cutoff is not an ancestor of its branch");
    entries.push({ ...entry, headSha, baseSha });
  }
  return validateRepoStack(project, { ...input, entries });
}

export function validateRepoStack(project: Project, stack: RepoStack): RepoStack {
  if (!idPattern.test(stack.id) || stack.projectId !== project.id) throw stackError("invalid-input", "invalid repository stack identity");
  const repositories = projectRepositories(project);
  if (!repositories.some((repository) => repository.id === stack.repositoryId)) throw stackError("not-found", "repository is not part of this project");
  if (!branchPattern.test(stack.baseBranch)) throw stackError("invalid-input", "invalid stack base branch");
  const seen = new Set<string>();
  if (!Array.isArray(stack.entries) || stack.entries.length > 64) throw stackError("invalid-input", "a stack supports up to 64 branches");
  for (const entry of stack.entries) {
    if (!entry || typeof entry !== "object") throw stackError("invalid-input", "invalid stack entry");
    if (!branchPattern.test(entry.branch) || !branchPattern.test(entry.baseBranch) || seen.has(entry.branch)) throw stackError("invalid-input", "stack branches must be unique and valid");
    if (entry.branch === entry.baseBranch || (!seen.has(entry.baseBranch) && entry.baseBranch !== stack.baseBranch)) throw stackError("invalid-input", "stack ancestry must be ordered and repository scoped");
    if (!/^[0-9a-f]{40,64}$/i.test(entry.headSha) || !/^[0-9a-f]{40,64}$/i.test(entry.baseSha)) throw stackError("invalid-input", "stack entries require immutable commit ids");
    seen.add(entry.branch);
  }
  return stack;
}

export async function previewRepoStack(git: GitService, root: string, stack: RepoStack): Promise<RepoStackPreview> {
  const warnings: string[] = [];
  const status = await git.status(root);
  if (!status.clean) warnings.push("repository has dirty work; restack will not overwrite it");
  const entries: RepoStackPreviewEntry[] = [];
  for (const item of stack.entries) {
    const head = await git.revParse(root, item.branch);
    const base = await git.revParse(root, item.baseBranch);
    if (head !== item.headSha && !await git.isAncestor(root, item.headSha, head)) warnings.push(`${item.branch} history changed since this stack was saved`);
    const expectedRemoteSha = await git.readRef(root, `refs/remotes/origin/${item.branch}`).catch(() => null);
    entries.push({ branch: item.branch, fromBaseBranch: item.baseBranch, ontoBaseBranch: item.baseBranch, expectedHeadSha: head, expectedBaseSha: item.baseSha, expectedOntoSha: base, plannedHeadSha: head, ...(expectedRemoteSha ? { remote: "origin", expectedRemoteSha } : {}) });
  }
  return { stackId: stack.id, projectId: stack.projectId, repositoryId: stack.repositoryId, expectedFingerprint: await git.fingerprint(root), entries, warnings, requiresRemoteForceWithLease: entries.length > 0 };
}

export async function applyRepoStack(git: GitService, root: string, stack: RepoStack, preview: RepoStackPreview): Promise<RepoStackApplyResult> {
  if (!git.rebaseOnto) throw stackError("unsupported", "Git rebase primitive is unavailable");
  const currentPreview = await previewRepoStack(git, root, stack);
  if (!preview || !isDeepStrictEqual(preview, currentPreview) || currentPreview.warnings.length) throw stackError("conflict", "stack preview is stale or blocked; refresh before restacking");
  const trees = await git.worktrees.list(root);
  const outcomes: RepoStackApplyResult["outcomes"] = [];
  for (const planned of preview.entries) {
    const entry = stack.entries[outcomes.length];
    if (!entry || planned.branch !== entry.branch || planned.fromBaseBranch !== entry.baseBranch) throw stackError("conflict", "stack preview does not match the canonical stack");
    const current = await git.revParse(root, entry.branch);
    if (current !== planned.expectedHeadSha) {
      outcomes.push({ branch: entry.branch, ok: false, oldSha: current, reason: "branch changed since preview" });
      break;
    }
    const priorParent = outcomes.find((outcome) => outcome.branch === entry.baseBranch && outcome.ok);
    const expectedOnto = priorParent?.newSha ?? planned.expectedOntoSha;
    if (await git.revParse(root, entry.baseBranch) !== expectedOnto) {
      outcomes.push({ branch: entry.branch, ok: false, oldSha: current, reason: "base branch changed since preview" });
      break;
    }
    if (trees.some((tree) => tree.branch === entry.branch)) {
      outcomes.push({ branch: entry.branch, ok: false, oldSha: current, reason: "branch is checked out; refusing ref update" });
      break;
    }
    const scratchBranch = `polyth/restack/${stack.id}/${entry.branch.replaceAll("/", "-")}`;
    const scratchParent = await mkdtemp(join(tmpdir(), "polyth-restack-"));
    const scratchPath = join(scratchParent, "tree");
    let scratch: { path: string; branch: string } | undefined;
    try {
      scratch = await git.worktrees.create(root, { branch: scratchBranch, path: scratchPath, base: current, newBranchOnly: true });
      await git.rebaseOnto(scratch.path, expectedOnto, entry.baseSha);
      const nextSha = await git.revParse(scratch.path, "HEAD");
      const updated = await git.updateRef(root, `refs/heads/${entry.branch}`, nextSha, current);
      if (!updated) throw stackError("conflict", `${entry.branch} changed during restack`);
      outcomes.push({ branch: entry.branch, ok: true, oldSha: current, newSha: nextSha, ontoSha: expectedOnto, receipt: `${entry.branch}:${current}->${nextSha}` });
    } catch (error) {
      outcomes.push({ branch: entry.branch, ok: false, oldSha: current, reason: error instanceof Error ? error.message : String(error) });
      break;
    } finally {
      try {
        if (scratch) await git.worktrees.remove(root, { path: scratch.path, force: true, deleteBranch: true, ownedBranch: scratch.branch });
        await rm(scratchParent, { recursive: true, force: true });
      } catch (error) {
        // Ref publication is a completed mutation. Preserve its receipt and
        // cleanup location rather than hiding it behind an exception.
        const outcome = outcomes.at(-1);
        if (outcome) outcome.cleanupError = `${scratchPath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (outcomes.at(-1)?.cleanupError) break;
  }
  return { stackId: stack.id, projectId: stack.projectId, repositoryId: stack.repositoryId, outcomes, partial: outcomes.some((item) => item.ok) && (outcomes.length < stack.entries.length || outcomes.some((item) => !item.ok || item.cleanupError)) };
}

export async function pushRepoStackBranch(git: GitService, root: string, input: { branch: string; remote: string; expectedRemoteSha: string; expectedLocalSha: string }): Promise<RepoStackPushResult> {
  if (!git.pushForceWithLease) throw stackError("unsupported", "guarded push primitive is unavailable");
  if (!branchPattern.test(input.branch) || !/^[\w.-]{1,120}$/.test(input.remote) || !/^[0-9a-f]{40,64}$/i.test(input.expectedRemoteSha)) throw stackError("invalid-input", "invalid guarded push input");
  if (!/^[0-9a-f]{40,64}$/i.test(input.expectedLocalSha)) throw stackError("invalid-input", "invalid expected local SHA");
  const local = await git.revParse(root, input.branch);
  if (local !== input.expectedLocalSha) throw stackError("conflict", "local branch changed since preview");
  const current = await git.revParse(root, input.branch);
  const result = await git.pushForceWithLease(root, input);
  return { branch: input.branch, remote: input.remote, expectedRemoteSha: input.expectedRemoteSha, newSha: result.newSha || current, receipt: `${input.remote}:${input.branch}:${input.expectedRemoteSha}->${result.newSha || current}` };
}
