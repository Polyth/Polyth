// NTF-01 notification centre surfaces: the header bell and the right-rail
// panel. Both are contributed through the slot registry (app.header.actions
// and workspace.right.tabs) — App.tsx, Header.tsx, and ContextRail.tsx are
// never edited and never enumerate them. All merge/mutation logic lives in
// ../notificationCentre.ts; records are the server's canonical, already
// redacted payloads and are rendered as-is (never re-templated here).
import { useState } from "react";
import type { NotificationRecord } from "@polyth/contracts";
import { registerSlot } from "../slots.ts";
import { toggleRailPlugin, useStore } from "../store.ts";
import { openSession } from "../init.ts";
import { useUiSettings } from "../uiPrefs.ts";
import {
  NOTIFICATION_KIND_LABELS, bellBadge, bellName, canOpenNotification, centreRows,
  notificationCentre, useNotificationCentre, type NotificationCentre,
} from "../notificationCentre.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "../widgets/catalog.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { RAIL_ICONS } from "../railIcons.ts";

/** The rail-surface id the workspace.right.tabs slot bridge derives for the
 *  panel — what the bell toggles and hosts persist as the open surface. */
export const NOTIFICATION_SURFACE_ID = "slot:notification-centre";

const STROKE = {
  fill: "none", stroke: "currentColor", strokeWidth: 1.5,
  strokeLinecap: "round", strokeLinejoin: "round",
} as const;

/** Header bell: global unread badge + rail toggle. Global inbox — available
 *  with or without an active session. The badge caps at 99+ visually while the
 *  accessible name always carries the exact count. */
export function NotificationBell({ centre = notificationCentre }: { centre?: NotificationCentre }) {
  const { unread } = useNotificationCentre(centre);
  const open = useStore((s) => s.railPlugin) === NOTIFICATION_SURFACE_ID;
  const badge = bellBadge(unread);
  return (
    <button
      className={`header-action notification-bell${open ? " active" : ""}`}
      title={tr("notificationcentre.notifications")}
      aria-label={bellName(unread)}
      aria-expanded={open}
      onClick={() => toggleRailPlugin(NOTIFICATION_SURFACE_ID)}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...STROKE}>
        <path d="M8 2a4 4 0 0 0-4 4v2.6L2.8 11.2h10.4L12 8.6V6a4 4 0 0 0-4-4z" />
        <path d="M6.6 13.2a1.5 1.5 0 0 0 2.8 0" />
      </svg>
      {badge !== null && <span className="notification-badge" aria-hidden="true">{badge}</span>}
    </button>
  );
}

/** Same-day timestamps show the time; older ones add the date. The semantic
 *  <time dateTime> always carries the full ISO instant. */
function fmtWhen(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(getLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
        disabled={!alive}
        onClick={() => onActivate(record)}
      >
        <span className="ntc-top">
          <span className={`ntc-kind kind-${record.kind}`}>{NOTIFICATION_KIND_LABELS[record.kind]}</span>
          {!record.read && <span className="sr-only">{tr("notificationcentre.unread")}</span>}
          <time className="ntc-time" dateTime={new Date(record.ts).toISOString()}>{fmtWhen(record.ts)}</time>
        </span>
        <span className="ntc-title">{record.title}</span>
        {record.body !== "" && <span className="ntc-body">{record.body}</span>}
        {!alive && <span className="ntc-gone">{tr("notificationcentre.sessionNoLongerAvailable")}</span>}
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
    if (!record.read) void centre.markRead([record.id]);
    void open(record.sessionId).catch(() => {});
  };

  return (
    <div className="notification-centre">
      <div className="ntc-toolbar">
        <button
          className="small-btn"
          disabled={state.unread === 0}
          onClick={() => void centre.markAllRead()}
        >{tr("notificationcentre.markAllRead")}</button>
        {!confirmClear && (
          <button
            className="small-btn"
            disabled={state.items.length === 0}
            onClick={() => setConfirmClear(true)}
          >{tr("notificationcentre.clearNotifications")}</button>
        )}
        {confirmClear && (
          <>
            <button
              className="small-btn ntc-confirm"
              onClick={() => { setConfirmClear(false); void centre.clear(); }}
            >{tr("notificationcentre.confirmClear")}</button>
            <button className="small-btn" onClick={() => setConfirmClear(false)}>{tr("common.cancel")}</button>
          </>
        )}
      </div>
      {state.error !== null && (
        <div className="ntc-error" role="alert">
          <span>{state.error}</span>
          <button className="small-btn" onClick={() => void centre.catchUp()}>{tr("common.retry")}</button>
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
      supportedSlots: ["app.header.actions"],
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
      icon: RAIL_ICONS["notification-centre"],
    },
  );
}
