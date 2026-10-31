import { confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

/** Full access approves every request in the session (and subagents that
 * inherit it) without asking, high-risk ones included; only explicit deny
 * rules still apply. It is only ever turned on by a person who confirmed it. */
export const confirmFullAccess = (): Promise<boolean> =>
  confirmAlert(tr("permissionbanner.fullAccessConfirm"), {
    title: tr("permissionbanner.fullAccessConfirmTitle"),
    confirmLabel: tr("permissionbanner.fullAccessConfirmLabel"),
    destructive: true,
    // Reached from the composer's approval switch, which holds the software
    // keyboard open; the confirmation must not dismiss it.
    keepKeyboard: true,
  });
