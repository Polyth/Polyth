import { useState, useSyncExternalStore } from "react";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { tr } from "../i18n/index.ts";
import { listSlots, slotRegistryVersion, subscribeSlots } from "../slots.ts";
import { useStore } from "../store.ts";
import SlotHost from "./slots/SlotHost.ts";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import { Icon, Menu, MoreVerticalIcon, PinIcon, type MenuEntry } from "./ui/index.ts";

/** Chat-only presentation preferences. Purely local state stays out of the event log. */
export default function ChatMenu({ className = "header-chat-menu" }: { className?: string }) {
  const ui = useUiSettings();
  const pinned = ui.pinLatestUserMessage;
  const sessionId = useStore((state) => state.activeSessionId);
  const projectId = useStore((state) => state.activeProjectId);
  const [actionsOpen, setActionsOpen] = useState(false);
  useSyncExternalStore(subscribeSlots, slotRegistryVersion, slotRegistryVersion);
  const extensionActions = listSlots("session.header.actions").length;
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
  if (extensionActions > 0) {
    entries.push({
      id: "extension-session-actions",
      label: extensionActions === 1 ? "Extension action" : `Extension actions (${extensionActions})`,
      onSelect: () => setActionsOpen(true),
    });
  }

  return (
    <>
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
      <ResponsiveOverlay
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
        title="Session actions"
        desktop="dialog"
        sheetSize="auto"
        dialogSize="sm"
      >
        <SlotHost
          slot="session.header.actions"
          context={{ projectId, sessionId, presentation: "menu" }}
        />
      </ResponsiveOverlay>
    </>
  );
}
