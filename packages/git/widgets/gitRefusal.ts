// Git refusals that the person can fix themselves (Spaces §14.4): a missing
// commit identity or no usable hosting account. Every Git action error in this
// package goes through `reportGitError`, which keeps the server's sentence and
// adds the one action that resolves it.
import { errorCodeOf } from "@polyth/session/web-api";
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

export function gitRefusalAction(cause: unknown): UiErrorAction | null {
  const refusal = gitRefusalOf(cause);
  return refusal ? { label: refusal.label, run: () => openGitRefusal(refusal) } : null;
}

/** The shared Git error toast: the friendly sentence plus, for a fixable
 *  refusal, a button straight to the setting that fixes it. */
export function reportGitError(action: string, cause: unknown): void {
  setUiError(friendlyError(action, cause), gitRefusalAction(cause));
}
