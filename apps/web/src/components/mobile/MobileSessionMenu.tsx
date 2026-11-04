// The phone actions island's ⋮: the open session's menu, anchored under the
// island. It runs the same routes as the Navigator row menu (rename through the
// shared prompt, since the island has no inline title field) and mounts the
// `sidebar.session.actions` slot, so package actions appear here too.
import { useRef, useState, type RefObject } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { tr } from "../../i18n/index.ts";
import { confirmAlert, promptAlert } from "../../alerts.ts";
import { deleteSession, forkSession } from "../../init.ts";
import { archiveSessionWithPolicy, renameSessionTitle, toggleSessionPin } from "../../sessionActions.ts";
import { canManageSession } from "../../sessionSharing.ts";
import { setSessionMuted } from "../../sessionPeople.ts";
import { openSessionSharing, setUiError } from "../../store.ts";
import { friendlyError } from "../../settings.ts";
import { copyText } from "../../utils.ts";
import { errorFeedback, successFeedback, tapFeedback } from "../../haptics.ts";
import type { SessionRowStatus } from "../../sessionStatus.ts";
import { announce } from "../a11y/live.tsx";
import SlotHost from "../slots/SlotHost.ts";
import {
  ArchiveIcon,
  BellIcon,
  ChevronRightIcon,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  ForkIcon,
  Icon,
  IconButton,
  Menu,
  MoreVerticalIcon,
  PinIcon,
  SharedIcon,
  type MenuEntry,
} from "../ui/index.ts";
import { MobileStatusIcon } from "./MobileStatusIcon.tsx";
import "./MobileSessionMenu.css";

export interface MobileSessionMenuProps {
  session: SessionProjection;
  /** The title the header shows (generated or placeholder-resolved). */
  title: string;
  status: SessionRowStatus;
  /** One line under the title: status · model · context. */
  meta: string;
  pinnedSessions: readonly SessionProjection[];
  /** Opens the session overview; absent for a conversation, which has none. */
  onOpenOverview?: () => void;
  onChanged: () => void;
  /** The island the menu lines up under; defaults to the ⋮ itself. */
  anchorRef?: RefObject<HTMLElement | null>;
}

export default function MobileSessionMenu({
  session, title, status, meta, pinnedSessions, onOpenOverview, onChanged, anchorRef,
}: MobileSessionMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const fail = (error: unknown) => {
    errorFeedback();
    setUiError(friendlyError(tr("common.error"), error));
  };

  const rename = async () => {
    const next = await promptAlert(tr("mobile.sessionmenu.title"), {
      title: tr("mobile.sessionmenu.renameSession"),
      confirmLabel: tr("common.rename"),
      initialValue: session.title,
    });
    if (next === null) return;
    try {
      if (await renameSessionTitle(session.id, session.title, next)) onChanged();
    } catch (error) {
      fail(error);
    }
  };

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      successFeedback();
      onChanged();
    } catch (error) {
      fail(error);
    }
  };

  const copySessionId = async () => {
    if (await copyText(session.id)) {
      successFeedback();
      announce(tr("sidebar.sessionlist.sessionIdCopied"));
    } else {
      setUiError(tr("questioncards.copyFailedClipboardUnavailable"));
    }
  };

  const archive = async () => {
    try {
      // The policy may ask first; a declined confirmation changes nothing.
      if (!await archiveSessionWithPolicy(session)) return;
      successFeedback();
      onChanged();
    } catch (error) {
      fail(error);
    }
  };

  const remove = async () => {
    const label = session.title || tr("sidebar.sessionlist.session");
    const activity = session.isolation
      ? ` ${tr("sidebar.sessionlist.theLocalIsolationWorkspaceAndEveryFileInItWillAlsoBePermanentlyDeleted")}`
      : "";
    if (!await confirmAlert(
      tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label, activity }),
      { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") },
    )) return;
    await run(() => deleteSession(session.id));
  };

  // Rename, archive, delete and sharing changes need manage access.
  const manage = canManageSession(session);
  const entries: MenuEntry[] = [
    ...(manage ? [{ id: "rename", label: tr("common.rename"), icon: EditIcon, onSelect: () => void rename() } satisfies MenuEntry] : []),
    {
      id: "pin",
      label: session.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop"),
      icon: PinIcon,
      onSelect: () => void run(() => toggleSessionPin(session, pinnedSessions)),
    },
    ...(session.sharing ? [{
      id: "share",
      label: manage ? tr("sharing.share") : tr("sharing.whoHasAccess"),
      icon: SharedIcon,
      onSelect: () => openSessionSharing(session.id),
    } satisfies MenuEntry] : []),
    ...(!session.isolation ? [{
      id: "fork",
      label: tr("sidebar.sessionlist.fork"),
      icon: ForkIcon,
      onSelect: () => void forkSession(session.id).catch(fail),
    } satisfies MenuEntry] : []),
    ...(session.purpose === "conversation" ? [{
      id: "mute",
      label: session.muted ? tr("sidebar.sessionlist.unmuteConversation") : tr("sidebar.sessionlist.muteConversation"),
      icon: BellIcon,
      onSelect: () => void run(() => setSessionMuted(session.id, !session.muted)),
    } satisfies MenuEntry] : []),
    { id: "copy-id", label: tr("sidebar.sessionlist.copySessionId"), icon: CopyIcon, onSelect: () => void copySessionId() },
    ...(manage ? [
      "separator",
      { id: "archive", label: tr("common.archive"), icon: ArchiveIcon, onSelect: () => void archive() },
      { id: "delete", label: tr("common.delete"), icon: DeleteIcon, danger: true, onSelect: () => void remove() },
    ] satisfies MenuEntry[] : []),
  ];

  // The subject of the menu: which chat it acts on and how it is doing. A tap
  // opens the overview that the (often hidden) title would open.
  const headCopy = (
    <span className="mobile-session-menu-head-copy">
      <span className="mobile-session-menu-title" dir="auto">{title}</span>
      {meta && (
        <span className="mobile-session-menu-meta">
          <span className={`mobile-session-menu-status ${status.kind}`} aria-hidden="true">
            <MobileStatusIcon kind={status.kind} />
          </span>
          <span className="mobile-session-menu-meta-text">{meta}</span>
        </span>
      )}
    </span>
  );
  const header = (
    <>
      {onOpenOverview ? (
        <button
          type="button"
          role="menuitem"
          className="mobile-session-menu-head"
          aria-label={tr("mobile.island.openOverview", { label: [title, meta].filter(Boolean).join(", ") })}
          onClick={() => {
            setOpen(false);
            onOpenOverview();
          }}
        >
          {headCopy}
          <Icon icon={ChevronRightIcon} size="sm" className="mobile-session-menu-head-chevron" />
        </button>
      ) : (
        <div className="mobile-session-menu-head is-static">{headCopy}</div>
      )}
      <div className="ui-separator ui-separator--horizontal" role="separator" />
    </>
  );

  return (
    <Menu
      label={tr("mobile.sessionmenu.sessionActions")}
      entries={entries}
      align="end"
      phonePresentation="popover"
      className="mobile-session-menu"
      open={open}
      onOpenChange={setOpen}
      anchorRef={anchorRef}
      header={header}
      footer={<SlotHost slot="sidebar.session.actions" context={{
        sessionId: session.id,
        status: session.status,
        closeMenu: () => {
          setOpen(false);
          requestAnimationFrame(() => triggerRef.current?.focus());
        },
      }} />}
    >
      {(trigger) => (
        <IconButton
          {...trigger}
          ref={(node) => {
            triggerRef.current = node;
            const ref = trigger.ref;
            if (typeof ref === "function") ref(node);
            else if (ref && typeof ref === "object") (ref as { current: HTMLButtonElement | null }).current = node;
          }}
          icon={MoreVerticalIcon}
          label={tr("mobile.sessionmenu.sessionActions")}
          size="lg"
          variant="ghost"
          className="mobile-session-menu-trigger"
          onClick={() => {
            tapFeedback();
            trigger.onClick();
          }}
        />
      )}
    </Menu>
  );
}
