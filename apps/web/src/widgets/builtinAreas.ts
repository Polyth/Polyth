// Widget-areas (WA1): the built-in area catalogue. One entry per shell region
// the layout engine can host widgets in. Installed once from bootstrap.tsx.
//
// `label`/`description` read the catalog on every access, so a language
// switch shows in the placement pickers without re-registering the areas.
import { tr, type TranslationKey } from "../i18n/index.ts";
import { registerAreas, type WidgetArea } from "./areas.ts";

function area(
  spec: Omit<WidgetArea, "label" | "description">,
  label: TranslationKey,
  description: TranslationKey,
): WidgetArea {
  return Object.defineProperties({ ...spec } as WidgetArea, {
    label: { get: () => tr(label), enumerable: true },
    description: { get: () => tr(description), enumerable: true },
  });
}

export const BUILTIN_AREAS: readonly WidgetArea[] = [
  // ---- shell chrome -------------------------------------------------------
  area({
    id: "app.header.leading",
    group: "shell",
    orientation: "row",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: [],
    order: 10,
  }, "widgets.area.appHeaderLeading", "widgets.area.appHeaderLeadingDescription"),
  area({
    id: "app.header.center",
    group: "shell",
    orientation: "row",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: [
      "capability:files", "capability:browser", "capability:goals", "capability:workflow",
      "core.quick-actions",
    ],
    order: 11,
  }, "widgets.area.appHeaderCenter", "widgets.area.appHeaderCenterDescription"),
  area({
    id: "app.header.actions",
    group: "shell",
    orientation: "row",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: ["shell.search", "shell.settings"],
    order: 12,
  }, "widgets.area.appHeaderActions", "widgets.area.appHeaderActionsDescription"),
  area({
    id: "workspace.rail",
    group: "shell",
    orientation: "column",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: [
      "capability:git", "capability:terminal", "capability:usage", "capability:github",
      "capability:knowledge", "capability:schedule", "capability:multirun", "capability:context",
      "system.status",
    ],
    order: 13,
  }, "widgets.area.workspaceRail", "widgets.area.workspaceRailDescription"),
  // The status bar is opt-in (Settings → Appearance → Status bar). Its two
  // ends are separate areas so a segment can sit on either side.
  area({
    id: "app.statusbar.leading",
    group: "shell",
    orientation: "row",
    sizeHint: "compact",
    preferredKind: "mini-widget",
    recommends: [
      "statusbar.project", "statusbar.branch", "statusbar.editor", "statusbar.changes",
      "statusbar.model", "statusbar.agent", "statusbar.workflow",
    ],
    order: 14,
  }, "widgets.area.appStatusbarLeading", "widgets.area.appStatusbarLeadingDescription"),
  area({
    id: "app.statusbar.trailing",
    group: "shell",
    orientation: "row",
    sizeHint: "compact",
    preferredKind: "mini-widget",
    recommends: ["statusbar.view", "shell.search", "shell.settings"],
    order: 15,
  }, "widgets.area.appStatusbarTrailing", "widgets.area.appStatusbarTrailingDescription"),
  // ---- sidebar ----------------------------------------------------------
  area({
    id: "sidebar.toolbar",
    group: "sidebar",
    orientation: "row",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: ["shell.history"],
    order: 20,
  }, "widgets.area.sidebarToolbar", "widgets.area.sidebarToolbarDescription"),
  area({
    id: "sidebar.rail",
    group: "sidebar",
    orientation: "column",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: ["shell.search", "shell.settings"],
    order: 20.5,
  }, "widgets.area.sidebarRail", "widgets.area.sidebarRailDescription"),
  area({
    id: "sidebar.footer",
    group: "sidebar",
    orientation: "row",
    sizeHint: "compact",
    recommends: ["system.status"],
    order: 21,
  }, "widgets.area.sidebarFooter", "widgets.area.sidebarFooterDescription"),
  // ---- workspace canvas zones -----------------------------------------
  area({
    id: "workspace.header",
    group: "workspace",
    orientation: "canvas",
    sizeHint: "compact",
    recommends: ["core.quick-actions", "goals.current"],
    order: 30,
  }, "widgets.area.workspaceHeader", "widgets.area.workspaceHeaderDescription"),
  area({
    id: "workspace.left",
    group: "workspace",
    orientation: "canvas",
    sizeHint: "panel",
    recommends: ["files.project-map", "knowledge.notes", "files.explorer"],
    order: 31,
  }, "widgets.area.workspaceLeft", "widgets.area.workspaceLeftDescription"),
  area({
    id: "workspace.main",
    group: "workspace",
    orientation: "canvas",
    sizeHint: "flexible",
    recommends: ["core.chat"],
    order: 32,
  }, "widgets.area.workspaceMain", "widgets.area.workspaceMainDescription"),
  area({
    id: "workspace.right",
    group: "workspace",
    orientation: "canvas",
    sizeHint: "panel",
    recommends: ["git.recent", "session.work-status", "session.activity", "usage.project"],
    order: 33,
  }, "widgets.area.workspaceRight", "widgets.area.workspaceRightDescription"),
  area({
    id: "workspace.bottom",
    group: "workspace",
    orientation: "canvas",
    sizeHint: "flexible",
    recommends: ["terminal.shell", "browser.app"],
    order: 34,
  }, "widgets.area.workspaceBottom", "widgets.area.workspaceBottomDescription"),
  area({
    id: "workspace.floating",
    group: "workspace",
    orientation: "canvas",
    sizeHint: "compact",
    recommends: [],
    order: 35,
  }, "widgets.area.workspaceFloating", "widgets.area.workspaceFloatingDescription"),
  // ---- session surface -------------------------------------------------
  area({
    id: "session.empty.widgets",
    group: "session",
    orientation: "column",
    sizeHint: "flexible",
    recommends: [],
    order: 40,
  }, "widgets.area.sessionEmptyWidgets", "widgets.area.sessionEmptyWidgetsDescription"),
  area({
    id: "session.composer.before",
    group: "session",
    orientation: "column",
    sizeHint: "compact",
    recommends: ["usage.session", "github.pr-summary", "todos.progress"],
    order: 41,
  }, "widgets.area.sessionComposerBefore", "widgets.area.sessionComposerBeforeDescription"),
  area({
    id: "session.footer",
    group: "session",
    orientation: "row",
    sizeHint: "compact",
    recommends: [],
    order: 42,
  }, "widgets.area.sessionFooter", "widgets.area.sessionFooterDescription"),
  // ---- composer -------------------------------------------------------
  area({
    id: "composer.meta",
    group: "composer",
    orientation: "row",
    sizeHint: "compact",
    recommends: [],
    order: 50,
  }, "widgets.area.composerMeta", "widgets.area.composerMetaDescription"),
  area({
    id: "composer.pending",
    group: "composer",
    orientation: "row",
    sizeHint: "compact",
    recommends: [],
    order: 51,
  }, "widgets.area.composerPending", "widgets.area.composerPendingDescription"),
  area({
    id: "composer.leading",
    group: "composer",
    orientation: "row",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: [],
    order: 52,
  }, "widgets.area.composerLeading", "widgets.area.composerLeadingDescription"),
  area({
    id: "composer.trailing",
    group: "composer",
    orientation: "row",
    sizeHint: "icon",
    preferredKind: "mini-widget",
    recommends: [],
    order: 53,
  }, "widgets.area.composerTrailing", "widgets.area.composerTrailingDescription"),
];

let installed = false;

export function installBuiltinAreas(): void {
  if (installed) return;
  installed = true;
  registerAreas(BUILTIN_AREAS);
}
