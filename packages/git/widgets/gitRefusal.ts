// Git refusals that the person can fix themselves (Spaces §14.4): a missing
// commit identity or no usable hosting account. Every Git action error in this
// package goes through `reportGitError`, which keeps the server's sentence and
// adds the one action that resolves it.
import { errorCodeOf, errorRefusalOf } from "@polyth/session/web-api";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openSettingsPage, setUiError, type UiErrorAction } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export const GIT_IDENTITY_REQUIRED = "git-identity-required";
export const GIT_ACCOUNT_REQUIRED = "git-account-required";
/** `data-settings-item` of the region holding the person's GitHub/GitLab accounts. */
export const PERSON_ACCOUNTS_ITEM = "git.personAccounts";
export const PERSON_PROFILE_ITEM = "git.personProfile";

export type GitRefusal = { code: typeof GIT_IDENTITY_REQUIRED | typeof GIT_ACCOUNT_REQUIRED; label: string; itemId: string };

/** The fixable refusal behind `cause`, if any. The route only carries the code
 *  (its `reason` stays server-side), so a lost membership reads like a missing
 *  account; its own message says which. */
export function gitRefusalOf(cause: unknown): GitRefusal | null {
  const code = errorCodeOf(cause);
  if (code === GIT_IDENTITY_REQUIRED) return { code, label: tr("gitreg.setCommitIdentity"), itemId: PERSON_PROFILE_ITEM };
  if (code === GIT_ACCOUNT_REQUIRED) {
    const message = cause instanceof Error ? cause.message : "";
    if (/no longer a member/i.test(message)) return null;
    return { code, label: tr("gitreg.connectAccount"), itemId: PERSON_ACCOUNTS_ITEM };
  }
  return null;
}

export const openGitRefusal = (refusal: GitRefusal): void =>
  openSettingsPage("git", { itemId: refusal.itemId });

/** A refused branch change, as the server's typed 409 describes it. */
export type BranchRefusal =
  | { code: "branch-in-use"; branch: string; worktreePath?: string; worktreeLabel?: string; sessionIds: string[] }
  | { code: "worktree-dirty"; files: string[]; count: number };

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function branchRefusalOf(cause: unknown): BranchRefusal | null {
  const code = errorCodeOf(cause);
  const detail = errorRefusalOf(cause);
  if (code === "branch-in-use" && typeof detail.branch === "string") {
    return {
      code,
      branch: detail.branch,
      ...(typeof detail.worktreePath === "string" ? { worktreePath: detail.worktreePath } : {}),
      ...(typeof detail.worktreeLabel === "string" ? { worktreeLabel: detail.worktreeLabel } : {}),
      sessionIds: strings(detail.sessionIds),
    };
  }
  // The remove-worktree refusal shares this code but carries no file list.
  if (code === "worktree-dirty" && Array.isArray(detail.files)) {
    const files = strings(detail.files);
    return { code, files, count: typeof detail.count === "number" ? detail.count : files.length };
  }
  return null;
}

export function branchRefusalMessage(refusal: BranchRefusal): string {
  return refusal.code === "branch-in-use"
    ? tr("gitview.branchInUse", { branch: refusal.branch, worktree: refusal.worktreeLabel ?? tr("gitview.thisWorktree") })
    : tr("gitview.branchDirty", { files: refusal.files.join(", ") });
}

/** What the Git view can do for a refusal. Navigation lives in the host's
 *  store, so the caller supplies it; this module only decides which action. */
export interface GitRefusalContext {
  projectId?: string;
  /** Open an existing chat. */
  openSession?: (sessionId: string) => void;
  /** Start a chat in the checkout at `worktreePath`. */
  startChatIn?: (projectId: string, worktreePath: string) => void;
  /** Show the Changes tab. */
  reviewChanges?: () => void;
}

export function gitRefusalAction(cause: unknown, context: GitRefusalContext = {}): UiErrorAction | null {
  const branch = branchRefusalOf(cause);
  if (branch?.code === "branch-in-use") {
    const { sessionIds, worktreePath } = branch;
    // The newest chat there; with none, a new chat in that checkout.
    if (sessionIds[0] && context.openSession) {
      const id = sessionIds[0];
      return { label: tr("gitview.openThatWorktree"), run: () => context.openSession!(id) };
    }
    if (worktreePath && context.projectId && context.startChatIn) {
      const projectId = context.projectId;
      return { label: tr("gitview.openThatWorktree"), run: () => context.startChatIn!(projectId, worktreePath) };
    }
    return null;
  }
  if (branch?.code === "worktree-dirty") {
    return context.reviewChanges ? { label: tr("gitview.reviewChanges"), run: context.reviewChanges } : null;
  }
  const refusal = gitRefusalOf(cause);
  return refusal ? { label: refusal.label, run: () => openGitRefusal(refusal) } : null;
}

/** The shared Git error toast: the friendly sentence plus, for a fixable
 *  refusal, a button straight to what fixes it. A refused branch change keeps
 *  Git's own explanation instead of a generic "couldn't update". */
export function reportGitError(action: string, cause: unknown, context?: GitRefusalContext): void {
  const branch = branchRefusalOf(cause);
  setUiError(branch ? branchRefusalMessage(branch) : friendlyError(action, cause), gitRefusalAction(cause, context));
}
