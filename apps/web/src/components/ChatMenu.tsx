import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { tr } from "../i18n/index.ts";
import { Icon, Menu, MoreVerticalIcon, PinIcon, type MenuEntry } from "./ui/index.ts";

/** Chat-only presentation preferences. Purely local state stays out of the event log. */
export default function ChatMenu({ className = "header-chat-menu" }: { className?: string }) {
  const ui = useUiSettings();
  const pinned = ui.pinLatestUserMessage;
  const label = pinned
    ? tr("header.unpinLatestUserMessage")
    : tr("header.pinLatestUserMessage");
  const entries: MenuEntry[] = [{
    id: "pin-latest-user-message",
    label,
    icon: PinIcon,
    kind: "checkbox",
    checked: pinned,
    onSelect: () => setUiSettings({ pinLatestUserMessage: !pinned }),
  }];

  return (
    <Menu label={tr("header.chatMenu")} title={tr("header.chat")} entries={entries} align="end">
      {(trigger) => (
        <button
          {...trigger}
          type="button"
          className={className}
          aria-label={tr("header.chatMenu")}
          title={tr("header.chatMenu")}
        >
          <Icon icon={MoreVerticalIcon} size="sm" />
        </button>
      )}
    </Menu>
  );
}
