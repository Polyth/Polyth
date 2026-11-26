// NTF-01 notification centre surfaces: the header bell and the right-rail
// panel. Both are contributed through the slot registry (app.header.actions
// and workspace.right.tabs) — App.tsx, Header.tsx, and ContextRail.tsx are
// never edited and never enumerate them. All merge/mutation logic lives in
// ../notificationCentre.ts; records are the server's canonical, already
// redacted payloads and are rendered as-is (never re-templated here), except
// that a limit notice reads as a reached limit on the reader's own clock.
import { useState } from "react";
import type { NotificationKind as CentreKind, NotificationRecord } from "@polyth/contracts";
import { registerSlot } from "../slots.ts";
import { toggleRailPlugin, useStore } from "../store.ts";
import { openSession } from "../init.ts";
import { useUiSettings } from "../uiPrefs.ts";
import {
  bellBadge, bellName, canOpenNotification, centreRows, notificationBody, notificationCentre,
  notificationKindLabel, notificationWhen, useNotificationCentre, type NotificationCentre,
} from "../notificationCentre.ts";
import { notificationSource, openNotificationRecord } from "../notificationTarget.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "../widgets/catalog.ts";
import { tr } from "../i18n/index.ts";
import { RAIL_ICONS } from "../railIcons.ts";
import { Button, BellIcon, IconButton } from "./ui/index.ts";
import NotificationGlyph from "../notify/NotificationGlyph.tsx";
import { personInitials, personToneInSession } from "../sessionPeople.ts";
import type { NotificationKind as NoticeKind } from "../notify/store.ts";

/** A centre record reads in the same kind language as the transient stack. */
export const CENTRE_NOTICE_KIND: Readonly<Record<CentreKind, NoticeKind>> = {
  completed: "success",
  failed: "error",
  question: "hint",
  permission: "warning",
  subagent: "info",
  mention: "mention",
  message: "message",
};

/** The rail-surface id the workspace.right.tabs slot bridge derives for the
 *  panel — what the bell toggles and hosts persist as the open surface. */
export const NOTIFICATION_SURFACE_ID = "slot:notification-centre";

/** Header bell: global unread badge + rail toggle. Global inbox — available
 *  with or without an active session. The badge caps at 99+ visually while the
 *  accessible name always carries the exact count. */
export function NotificationBell({ centre = notificationCentre }: { centre?: NotificationCentre }) {
  const { unread } = useNotificationCentre(centre);
  const open = useStore((s) => s.railPlugin) === NOTIFICATION_SURFACE_ID;
  const badge = bellBadge(unread);
  return (
    <span className={`header-action notification-bell${open ? " active" : ""}`}>
      <IconButton
        icon={BellIcon}
        size="md"
        variant="ghost"
        label={bellName(unread)}
        title={tr("notificationcentre.notifications")}
        pressed={open}
        aria-expanded={open}
        onClick={() => toggleRailPlugin(NOTIFICATION_SURFACE_ID)}
      />
      {badge !== null && <span className="notification-badge" aria-hidden="true">{badge}</span>}
    </span>
  );
}

function NotificationRow({
  record, alive, onActivate,
}: {
  record: NotificationRecord;
  alive: boolean;
  onActivate: (record: NotificationRecord) => void;
}) {
  return (
    <li>
      {/* A real <button>: pointer and Enter/Space share this one handler. */}
      <button
        className={`ntc-row${record.read ? "" : " unread"}`}
        data-kind={CENTRE_NOTICE_KIND[record.kind]}
        disabled={!alive}
        onClick={() => onActivate(record)}
      >
        {/* Unread is a tone dot plus a stronger title and sr-only text — never color alone. */}
        <span className="ntc-dot" aria-hidden="true" />
        {/* A person's message shows who wrote it: their monogram in the colour
            the chat gives them. */}
        {record.author
          ? (
            <span className="person-mark ntc-glyph ntc-person" data-person-tone={personToneInSession(record.sessionId, record.author.userId)} aria-hidden="true">
              {personInitials(record.author.name || record.author.userId)}
            </span>
          )
          : <NotificationGlyph kind={CENTRE_NOTICE_KIND[record.kind]} className="ntc-glyph" />}
        {/* The date rides the meta line, not a column of its own: a trailing
            no-wrap date takes ~100px and leaves the title a sliver of a narrow rail panel. */}
        <span className="ntc-main">
          <span className="ntc-title">{record.title}</span>
          {record.body !== "" && <span className="ntc-body">{notificationBody(record)}</span>}
          <span className="ntc-meta">
            <span className={`ntc-kind kind-${record.kind}`}>{notificationKindLabel(record)}</span>
            {record.joinedSpace && <span className="ntc-kind ntc-source">{notificationSource(record.joinedSpace)}</span>}
            {!record.read && <span className="sr-only">{tr("notificationcentre.unread")}</span>}
            <time className="ntc-time" dateTime={new Date(record.ts).toISOString()}>{notificationWhen(record.ts)}</time>
          </span>
          {!alive && <span className="ntc-gone">{tr("notificationcentre.sessionNoLongerAvailable")}</span>}
        </span>
      </button>
    </li>
  );
}

/** Rail panel: newest first, mark-read on open, read-all, confirmed clear.
 *  Rows navigate only while the session registry still contains the target
 *  session in the same project; dead rows stay visible but disabled. */
export function NotificationCentrePanel({
  centre = notificationCentre,
  open = openSession,
}: {
  centre?: NotificationCentre;
  /** Injectable navigation seam (tests); production uses init.openSession. */
  open?: (sessionId: string) => Promise<void>;
}) {
  const state = useNotificationCentre(centre);
  const sessions = useStore((s) => s.sessions);
  const historyOn = useUiSettings().notificationCentreHistory;
  const [confirmClear, setConfirmClear] = useState(false);
  const rows = centreRows(state.items, historyOn);

  const activate = (record: NotificationRecord): void => {
    const marked = record.read ? undefined : centre.markRead([record.id]);
    // Switching to a joined Space reloads the page: the row is marked read first.
    const opened = record.joinedSpace || record.settings
      ? Promise.resolve(marked).catch(() => {}).then(() => openNotificationRecord(record, open))
      : open(record.sessionId);
    void opened.catch(() => {});
  };

  return (
    <div className="notification-centre">
      <div className="ntc-toolbar">
        <Button
          size="sm"
          variant="ghost"
          disabled={state.unread === 0}
          onClick={() => void centre.markAllRead()}
        >{tr("notificationcentre.markAllRead")}</Button>
        {!confirmClear && (
          <Button
            size="sm"
            variant="ghost"
            disabled={state.items.length === 0}
            onClick={() => setConfirmClear(true)}
          >{tr("notificationcentre.clearNotifications")}</Button>
        )}
        {confirmClear && (
          <>
            <Button
              size="sm"
              variant="danger"
              className="ntc-confirm"
              onClick={() => { setConfirmClear(false); void centre.clear(); }}
            >{tr("notificationcentre.confirmClear")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>{tr("common.cancel")}</Button>
          </>
        )}
      </div>
      {state.error !== null && (
        <div className="ntc-error" role="alert">
          <span>{state.error}</span>
          <Button size="sm" onClick={() => void centre.catchUp()}>{tr("common.retry")}</Button>
        </div>
      )}
      {state.loading && rows.length === 0 && <div className="rail-empty">{tr("notificationcentre.loadingNotifications")}</div>}
      {!state.loading && state.error === null && rows.length === 0 && (
        <div className="rail-empty">
          {state.items.length > 0
            ? tr("notificationcentre.noUnreadNotifications")
            : tr("notificationcentre.nothingHereYetCompletionFailureQuestionAnd")}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="ntc-list">
          {rows.map((record) => (
            <NotificationRow
              key={record.id}
              record={record}
              alive={canOpenNotification(record, sessions)}
              onActivate={activate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const NOTIFICATION_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "notification-centre",
  name: tr("notificationcentre.notifications"),
  widgets: [
    {
      id: "notification.bell",
      title: tr("notificationcentre.notifications"),
      description: tr("notificationcentre.openTheNotificationCentreAndSeeUnread"),
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      // ...or either end of the optional status bar.
      supportedSlots: ["app.header.actions", "app.statusbar.leading", "app.statusbar.trailing"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 20,
      render: () => <NotificationBell />,
    },
  ],
});

let installed = false;

/** Idempotent boot registration. The bell is a layout-managed header widget;
 * the notification panel remains a slot contribution for the rail bridge. */
export function installNotificationCentre(): void {
  if (installed) return;
  installed = true;
  registerWidgetPlugin(NOTIFICATION_WIDGET_PLUGIN);
  registerSlot(
    "workspace.right.tabs",
    "notification-centre",
    () => <NotificationCentrePanel />,
    0,
    {
      title: tr("notificationcentre.notifications"),
      // The built-in capability gives the panel its rail placement, so the
      // rail editor lists it and it can be removed like any other launcher.
      capabilityId: "notification-centre",
      icon: RAIL_ICONS["notification-centre"],
    },
  );
}
