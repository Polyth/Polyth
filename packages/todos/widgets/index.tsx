import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import TodoRuleSettingsPage from "./TodoRuleSettingsPage.tsx";
import { SessionProgressBar, SubagentPanel } from "./SessionProgress.tsx";
import { BackgroundWorkSegment, TodoProgressSegment } from "./StatusbarSegments.tsx";
import { todoStrings } from "./strings.ts";

const SLOTS = ["session.composer.before", "workspace.right", "workspace.bottom", "workspace.main"] as const;
const STATUSBAR = ["app.statusbar.leading", "app.statusbar.trailing"] as const;

export default defineWebPackage((host) => () => {
  const t = todoStrings(host.ui.locale.get());
  const offWidgets = host.widgets.registerPlugin({
    id: "todos",
    name: "Todos",
    widgets: [
      {
        id: "todos.progress",
        title: t.progressTitle,
        description: t.progressDescription,
        defaultSlot: "session.composer.before",
        supportedSlots: SLOTS,
        category: "Todos",
        defaultSize: { w: 6, h: 3 },
        minSize: { w: 3, h: 2 },
        maxSize: { w: 12, h: 8 },
        audience: "standard",
        scope: "global",
        resizable: true,
        defaultVisible: false,
        render: ({ sessionId }) => createElement(SessionProgressBar, { host, sessionId }),
      },
      {
        id: "todos.subagents",
        title: t.subagentsTitle,
        description: t.subagentsDescription,
        defaultSlot: "workspace.right",
        supportedSlots: SLOTS,
        category: "Todos",
        defaultSize: { w: 6, h: 6 },
        minSize: { w: 3, h: 3 },
        maxSize: { w: 12, h: 30 },
        audience: "standard",
        scope: "global",
        resizable: true,
        defaultVisible: false,
        render: ({ sessionId }) => createElement(SubagentPanel, { host, sessionId }),
      },
      // Status-bar segments: visible once the bar is on, and empty (no room
      // taken) until the session has a todo list or background work.
      {
        id: "todos.statusbar.progress",
        title: t.statusbarProgressTitle,
        description: t.statusbarProgressHint,
        kind: "mini-widget",
        defaultSlot: "app.statusbar.leading",
        supportedSlots: STATUSBAR,
        category: "Todos",
        defaultSize: { w: 1, h: 1 },
        resizable: false,
        audience: "simple",
        defaultVisible: true,
        recommended: true,
        order: 65,
        render: ({ sessionId }) => createElement(TodoProgressSegment, { host, sessionId }),
      },
      {
        id: "todos.statusbar.background",
        title: t.statusbarBackgroundTitle,
        description: t.statusbarBackgroundHint,
        kind: "mini-widget",
        defaultSlot: "app.statusbar.trailing",
        supportedSlots: STATUSBAR,
        category: "Todos",
        defaultSize: { w: 1, h: 1 },
        resizable: false,
        audience: "simple",
        defaultVisible: true,
        recommended: true,
        order: 59,
        render: ({ sessionId }) => createElement(BackgroundWorkSegment, { host, sessionId }),
      },
    ],
  });
  const off = host.settings.registerPage({
    id: "todos",
    packageId: "todos",
    label: t.settingsTitle,
    group: "Customize",
    icon: "check",
    order: 35,
    component: () => createElement(TodoRuleSettingsPage, { host }),
    settingsItems: [
      {
        id: "todos.rule-enabled",
        pageId: "todos",
        label: t.requireLabel,
        description: t.requireDescription,
        keywords: ["todo", "todos", "plan", "tasks", "rule", "behavior", "TodoWrite"],
        focusTarget: "todos.rule-enabled",
      },
      {
        id: "todos.rule-text",
        pageId: "todos",
        label: t.ruleTextLabel,
        description: t.ruleTextDescription,
        keywords: ["todo", "rule", "instructions", "prompt"],
        focusTarget: "todos.rule-text",
      },
    ],
  });
  return () => { off(); offWidgets(); };
});
