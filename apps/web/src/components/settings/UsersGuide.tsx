// Settings → Users: how adding people works, in four plain steps and the roles
// behind them. It is the page's empty state while the owner is alone (with
// the Add user action), and otherwise opens from "How it works" beside it, so
// it guides a first-time owner without standing in a professional's way.
import { useId } from "react";
import type { SpaceRole } from "@polyth/contracts";
import { Button, Icon, IconButton } from "../ui/index.ts";
import { AddIcon, CloseIcon, KeyIcon, LockIcon, SendIcon, ShieldIcon, type LucideIcon } from "../ui/icons.ts";
import { roleText } from "./usersModel.ts";
import { tr, type TranslationKey } from "../../i18n/index.ts";

const STEPS: ReadonlyArray<{ icon: LucideIcon; title: TranslationKey; body: TranslationKey }> = [
  { icon: KeyIcon, title: "settings.users.guide.step1Title", body: "settings.users.guide.step1" },
  { icon: ShieldIcon, title: "settings.users.guide.step2Title", body: "settings.users.guide.step2" },
  { icon: SendIcon, title: "settings.users.guide.step3Title", body: "settings.users.guide.step3" },
  { icon: LockIcon, title: "settings.users.guide.step4Title", body: "settings.users.guide.step4" },
];

const ROLES: readonly SpaceRole[] = ["viewer", "member", "admin", "owner"];

export default function UsersGuide({ space, onAdd, onClose }: {
  /** Current Space name, for the roles heading. */
  space: string | null;
  /** The empty state's own Add user action. */
  onAdd?: () => void;
  /** Present when the guide was opened on demand. */
  onClose?: () => void;
}) {
  const headingId = useId();
  return (
    <section className="users-guide" aria-labelledby={headingId} data-variant={onAdd ? "empty" : "open"}>
      <div className="users-guide-head">
        <h4 className="users-guide-title" id={headingId}>{tr("settings.users.guide.title")}</h4>
        {onClose && <IconButton icon={CloseIcon} size="sm" label={tr("settings.users.guide.hide")} onClick={onClose} />}
      </div>
      <ol className="users-guide-steps">
        {STEPS.map((step) => (
          <li key={step.title} className="users-guide-step">
            <span className="users-guide-step-mark" aria-hidden="true"><Icon icon={step.icon} size="sm" /></span>
            <span className="users-guide-step-copy">
              <strong>{tr(step.title)}</strong>
              <span>{tr(step.body)}</span>
            </span>
          </li>
        ))}
      </ol>
      <details className="users-guide-roles">
        <summary>{space ? tr("settings.users.guide.rolesTitle", { space }) : tr("settings.users.guide.rolesTitleNoSpace")}</summary>
        <dl>
          {ROLES.map((role) => {
            const text = roleText(role);
            return (
              <div key={role} className="users-guide-role">
                <dt>{text.label}</dt>
                <dd>{text.detail}</dd>
              </div>
            );
          })}
          <div className="users-guide-role">
            <dt>{tr("settings.users.protectedMode")}</dt>
            <dd>{tr("settings.users.protectedModeHint")}</dd>
          </div>
        </dl>
      </details>
      {onAdd && (
        <div className="users-guide-foot">
          <Button variant="primary" iconStart={AddIcon} onClick={onAdd}>{tr("settings.users.addUser")}</Button>
        </div>
      )}
    </section>
  );
}
