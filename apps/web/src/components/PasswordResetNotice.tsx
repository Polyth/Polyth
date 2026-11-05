// A person whose password an administrator set must be able to tell: whoever
// set it could have signed in as them and read their private chats. The notice
// stays until they set their own password (the audit log decides, not a click),
// so someone using the account in their place can't dismiss it for them.
import { useEffect } from "react";
import { adminPasswordResetAt } from "../accounts.ts";
import { dateTimeFormatter, getLocale, tr } from "../i18n/index.ts";
import { dismissNotification, notify } from "../notify/store.ts";
import { openSettingsPage } from "../store.ts";
import { OWN_ACCOUNT_TARGET } from "./settings/usersModel.ts";

const NOTICE_ID = "security.admin-password-reset";

export default function PasswordResetNotice() {
  useEffect(() => {
    let live = true;
    void adminPasswordResetAt().then((at) => {
      if (!live) return;
      if (at === null) { dismissNotification(NOTICE_ID); return; }
      const date = dateTimeFormatter(getLocale(), { dateStyle: "long", timeStyle: "short" }).format(at);
      notify({
        id: NOTICE_ID,
        kind: "warning",
        title: tr("securityNotice.passwordResetTitle"),
        body: tr("securityNotice.passwordResetBody", { date }),
        duration: "sticky",
        dismissible: false,
        actions: [{ label: tr("securityNotice.changePassword"), primary: true, run: () => openSettingsPage("users", { itemId: OWN_ACCOUNT_TARGET }) }],
      });
    });
    return () => { live = false; };
  }, []);
  return null;
}
