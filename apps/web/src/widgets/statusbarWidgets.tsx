// The built-in status-bar segments. Each one is an ordinary mini-widget, so the
// bar is arranged exactly like every other widget area: add, hide, reorder or
// move a segment to the other end from the Customize menu or by dragging.
//
// Segments are presentational. `components/StatusBar.tsx` derives one
// `StatusbarModel` and publishes it through context; a segment placed where no
// status bar provides that model renders nothing instead of probing on its own.
import { useSyncExternalStore, type ReactNode } from "react";
import { openWorkspacePane, type AppView } from "../store.ts";
import { getSyncStatus, reconnectSync, subscribeSyncStatus } from "../init.ts";
import type { SyncStatus } from "../sync.ts";
import { getLocale, tr, type TranslationKey } from "../i18n/index.ts";
import {
  AssistIcon, BranchIcon, CheckIcon, CpuIcon, FileDiffIcon, FileIcon, Icon,
} from "../components/ui/index.ts";
import { useStatusbarModel } from "../statusbar/model.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";

const STATUSBAR_AREAS = ["app.statusbar.leading", "app.statusbar.trailing"] as const;

// Files/Git/Terminal/Preview are workspace panes beside Chat,
// not primary views — the open pane is appended to the label instead.
const VIEW_LABEL_KEY: Record<AppView, TranslationKey> = {
  session: "statusbar.chat",
  goals: "statusbar.goals",
  multirun: "widgets.builtinwidgets.multiRun",
  workflow: "statusbar.workflows",
  fusion: "statusbar.fusion",
  walkthrough: "statusbar.walkthrough",
  schedule: "statusbar.schedule",
  github: "statusbar.github",
};

/** Collapse the transport's six states into what the bar can say honestly:
 *  live, still trying, or down (offline, suspended and idle all need a nudge). */
function connectionTone(status: SyncStatus): "live" | "pending" | "down" {
  if (status === "connected") return "live";
  return status === "connecting" || status === "reconnecting" ? "pending" : "down";
}

const CONNECTION_LABEL_KEY = {
  live: "sidebar.connected",
  pending: "sidebar.connecting",
  down: "sidebar.connectionProblem",
} as const satisfies Record<string, TranslationKey>;

/** "1 changed file" / "5 changed files". Locales without a usable singular
 *  (Slavic and Arabic plurals) word the phrase so one form fits every count. */
function changedFilesLabel(count: number): string {
  const one = new Intl.PluralRules(getLocale()).select(count) === "one";
  return tr(one ? "statusbar.changedFileOne" : "statusbar.changedFileOther", { count });
}

function ProjectSegment() {
  const model = useStatusbarModel();
  const tone = connectionTone(useSyncExternalStore(subscribeSyncStatus, getSyncStatus, (): SyncStatus => "disconnected"));
  if (!model) return null;
  const name = model.projectName ?? "Polyth";
  const state = tr(CONNECTION_LABEL_KEY[tone]);
  return (
    <>
      <span className="sb sb-project" title={`${name} · ${state}`}>
        <span className="sb-live" data-connection={tone} aria-hidden="true" />
        <span className="sb-text">{name}</span>
        <span className="sr-only">{state}</span>
      </span>
      {tone === "down" && (
        <button type="button" className="sb sb-action sb-reconnect" data-fit-keep="" onClick={reconnectSync}>
          {tr("sidebar.reconnect")}
        </button>
      )}
    </>
  );
}

function BranchSegment() {
  const branch = useStatusbarModel()?.branch;
  if (!branch) return null;
  const title = [
    branch.name,
    branch.ahead > 0 ? tr("statusbar.ahead", { count: branch.ahead }) : null,
    branch.behind > 0 ? tr("statusbar.behind", { count: branch.behind }) : null,
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className="sb sb-branch sb-action"
      title={`${title} — ${tr("capabilities.sourceControl")}`}
      aria-label={`${title}. ${tr("capabilities.sourceControl")}`}
      onClick={() => openWorkspacePane("git")}
    >
      <Icon icon={BranchIcon} size="sm" />
      <span className="sb-text mono">{branch.name}</span>
      {branch.ahead > 0 && <span className="sb-delta" aria-hidden="true">↑{branch.ahead}</span>}
      {branch.behind > 0 && <span className="sb-delta" aria-hidden="true">↓{branch.behind}</span>}
    </button>
  );
}

function EditorSegment() {
  const editor = useStatusbarModel()?.editor;
  if (!editor) return null;
  const cursor = editor.line === null
    ? null
    : tr(editor.column === null ? "statusbar.cursorLine" : "statusbar.cursor", {
      line: editor.line,
      column: editor.column,
    });
  // The file name never truncates: only the directory in front of it gives way.
  const slash = editor.file.lastIndexOf("/") + 1;
  const where = `${editor.alias ? `${editor.alias} · ` : ""}${editor.file}`;
  return (
    <span className="sb sb-editor" title={where}>
      <Icon icon={FileIcon} size="sm" />
      <span className="sb-path">
        <span className="sb-path-dir">{editor.alias ? `${editor.alias} · ` : ""}{editor.file.slice(0, slash)}</span>
        <span className="sb-path-base">{editor.file.slice(slash)}</span>
      </span>
      <span className="sb-meta">{` · ${editor.language}${cursor ? ` · ${cursor}` : ""}`}</span>
    </span>
  );
}

function ChangesSegment() {
  const changes = useStatusbarModel()?.changes;
  if (!changes) return null;
  const files = changes.count === 0 ? tr("statusbar.noChanges") : changedFilesLabel(changes.count);
  const text = changes.aggregate
    ? changes.unavailable > 0
      ? tr("statusbar.aggregateUnavailable", { repos: changes.repositories, unavailable: changes.unavailable, changes: files })
      : tr("statusbar.aggregate", { repos: changes.repositories, changes: files })
    : files;
  return (
    <button
      type="button"
      className={`sb sb-changes sb-action${changes.count === 0 ? " is-clean" : ""}`}
      title={`${text} — ${tr("capabilities.sourceControl")}`}
      aria-label={`${text}. ${tr("capabilities.sourceControl")}`}
      onClick={() => openWorkspacePane("git")}
    >
      <Icon icon={changes.count === 0 ? CheckIcon : FileDiffIcon} size="sm" />
      <span className="sb-text">{text}</span>
    </button>
  );
}

function ModelSegment() {
  const model = useStatusbarModel();
  if (!model?.projectId) return null;
  const label = model.modelId ?? tr("statusbar.noModel");
  return (
    <span className="sb sb-model" title={label}>
      <Icon icon={CpuIcon} size="sm" />
      <span className="sb-text mono">{label}</span>
    </span>
  );
}

function AgentSegment() {
  const agent = useStatusbarModel()?.agent;
  if (!agent) return null;
  return (
    <span className="sb sb-agent">
      <Icon icon={AssistIcon} size="sm" />
      <span className="sb-text">{agent} {tr("statusbar.agent")}</span>
    </span>
  );
}

function ViewSegment() {
  const model = useStatusbarModel();
  if (!model) return null;
  return (
    <span className="sb sb-view">
      <span className="sb-text">
        {tr(VIEW_LABEL_KEY[model.view])}{model.paneTitle !== null ? ` · ${model.paneTitle}` : ""}
      </span>
    </span>
  );
}

let installed = false;

export function installStatusbarWidgets(): void {
  if (installed) return;
  installed = true;
  const segment = (
    id: string,
    order: number,
    title: TranslationKey,
    description: TranslationKey,
    render: () => ReactNode,
    options: { slot?: (typeof STATUSBAR_AREAS)[number] } = {},
  ) => ({
    id,
    title: tr(title),
    description: tr(description),
    kind: "mini-widget" as const,
    defaultSlot: options.slot ?? "app.statusbar.leading" as const,
    supportedSlots: STATUSBAR_AREAS,
    defaultVisible: true,
    recommended: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple" as const,
    order,
    render,
  });
  registerWidgetPlugin(defineWidgetPlugin({
    id: "statusbar",
    name: tr("statusbar.label"),
    widgets: [
      segment("statusbar.project", 10, "statusbar.widgetProject", "statusbar.widgetProjectHint", () => <ProjectSegment />),
      segment("statusbar.branch", 20, "statusbar.widgetBranch", "statusbar.widgetBranchHint", () => <BranchSegment />),
      segment("statusbar.editor", 30, "statusbar.widgetEditor", "statusbar.widgetEditorHint", () => <EditorSegment />),
      segment("statusbar.changes", 40, "statusbar.widgetChanges", "statusbar.widgetChangesHint", () => <ChangesSegment />),
      segment("statusbar.model", 50, "statusbar.widgetModel", "statusbar.widgetModelHint", () => <ModelSegment />),
      segment("statusbar.agent", 60, "statusbar.widgetAgent", "statusbar.widgetAgentHint", () => <AgentSegment />),
      // The workflow segment is registered by its own package; the
      // shell owns only its generic segments.
      segment("statusbar.view", 80, "statusbar.widgetView", "statusbar.widgetViewHint", () => <ViewSegment />, { slot: "app.statusbar.trailing" }),
    ],
  }));
}
