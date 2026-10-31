import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { SESSION_MARKERS_PACKAGE_ID } from "../src/markers.ts";
import { connectMarkers } from "./client.ts";
import { markerGrouping } from "./grouping.ts";
import MarkedChats from "./MarkedChats.tsx";
import { MarkerDialogLayer } from "./MarkerDialog.tsx";
import SessionMarkersSettingsPage from "./SettingsPage.tsx";
import { BulkMarkerMenu, SessionMarkerBadges, SessionMarkerHeader, SessionMarkerMenu } from "./SessionRow.tsx";

const PANEL_SLOTS = ["workspace.right", "workspace.left", "workspace.main", "workspace.bottom"] as const;
const fn = (value: unknown): (() => void) | undefined => typeof value === "function" ? value as () => void : undefined;

export default defineWebPackage((host) => () => {
  const disconnect = connectMarkers(host);
  const off = [
    host.slots.register({
      slot: "session.list.badges",
      id: "session-markers.badges",
      order: 20,
      render: ({ sessionId }) => typeof sessionId === "string"
        ? createElement(SessionMarkerBadges, { sessionId })
        : null,
    }),
    host.slots.register({
      slot: "session.header.status",
      id: "session-markers.header",
      order: 25,
      render: ({ sessionId }) => typeof sessionId === "string"
        ? createElement(SessionMarkerHeader, { sessionId })
        : null,
    }),
    host.slots.register({
      slot: "sidebar.session.actions",
      id: "session-markers.menu",
      // After the other package actions, so Delete is not split from them.
      order: 90,
      render: ({ sessionId, closeMenu }) => typeof sessionId === "string"
        ? createElement(SessionMarkerMenu, { key: sessionId, host, sessionId, closeMenu: fn(closeMenu) })
        : null,
    }),
    host.slots.register({
      slot: "sidebar.sessions.bulk.actions",
      id: "session-markers.bulk",
      order: 90,
      render: ({ sessionIds, closeMenu, done }) => Array.isArray(sessionIds) && sessionIds.length > 0
        ? createElement(BulkMarkerMenu, {
          host,
          sessionIds: sessionIds.filter((id): id is string => typeof id === "string"),
          closeMenu: fn(closeMenu),
          done: fn(done),
        })
        : null,
    }),
    host.slots.register({
      slot: "app.layers",
      id: "session-markers.dialog",
      render: () => createElement(MarkerDialogLayer, { host }),
    }),
    host.sessions.registerGrouping?.(markerGrouping()) ?? (() => {}),
    host.widgets.registerPlugin({
      id: SESSION_MARKERS_PACKAGE_ID,
      name: tr("sessionmarkers.settings.title"),
      widgets: [{
        id: "session-markers.marked-chats",
        title: tr("sessionmarkers.widget.title"),
        description: tr("sessionmarkers.widget.description"),
        defaultSlot: "workspace.right",
        supportedSlots: PANEL_SLOTS,
        category: tr("sessionmarkers.settings.title"),
        defaultSize: { w: 6, h: 8 },
        minSize: { w: 3, h: 3 },
        maxSize: { w: 12, h: 30 },
        audience: "standard",
        scope: "global",
        resizable: true,
        defaultVisible: false,
        render: () => createElement(MarkedChats, { host }),
      }],
    }),
    host.settings.registerPage({
      id: "session-markers",
      packageId: SESSION_MARKERS_PACKAGE_ID,
      label: tr("sessionmarkers.settings.title"),
      group: "Customize",
      icon: "tag",
      order: 36,
      component: () => createElement(SessionMarkersSettingsPage, { host }),
      settingsItems: [
        {
          id: "session-markers.custom",
          pageId: "session-markers",
          label: tr("sessionmarkers.settings.custom"),
          description: tr("sessionmarkers.settings.description"),
          keywords: ["marker", "markers", "label", "tag", "review", "reply later", "important", "flag"],
          focusTarget: "session-markers.custom",
        },
      ],
    }),
  ];
  return () => {
    for (const dispose of off.toReversed()) dispose();
    disconnect();
  };
});
