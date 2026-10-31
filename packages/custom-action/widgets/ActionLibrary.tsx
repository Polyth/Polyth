// The Custom actions home: a project chooser on top, the project's own
// actions and the Space-wide ones as launcher tiles (or as rows in Settings),
// recent runs, and the editor. Layout follows its container, so the same view
// works docked beside Chat, full screen on a phone and inside Settings.
import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from "react";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  AddIcon,
  Button,
  confirmAlert,
  DeleteIcon,
  EditIcon,
  GlobeIcon,
  HideIcon,
  PinIcon,
  Icon,
  Notice,
  PlayIcon,
  ProjectPicker,
  ShowIcon,
  Skeleton,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import ProjectGlyph from "../../../apps/web/src/components/ProjectGlyph.tsx";
import { PageHead, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  actionAvailableIn,
  groupActions,
  moveWithinScope,
  type CustomActionDto,
} from "../src/actionModel.ts";
import ActionGlyph from "./ActionGlyph.tsx";
import ActionTile from "./ActionTile.tsx";
import { ACTION_TEMPLATES } from "./templates.ts";
import {
  ensureLoaded,
  focusRun,
  refresh,
  reorderActions,
  saveAction,
  deleteAction,
  useActions,
} from "./store.ts";
import { tileIsTransient, tileView } from "./tileState.ts";
import { useNow } from "./time.ts";
import { useActionSurface } from "./useActionSurface.tsx";
import { actionHost } from "./host.ts";
import RecentRuns from "./RecentRuns.tsx";
import { actionCapabilityId, railState, setOnRail, useRailPlacementVersion } from "./railLaunchers.tsx";

/** The project last chosen here, for the rest of this page's life. */
let rememberedProjectId: string | null = null;

type Scope = "project" | "global";

interface DragState {
  id: string;
  scope: Scope;
}

export default function ActionLibrary({
  variant,
  projectId: shellProjectId = null,
}: {
  variant: "window" | "settings";
  projectId?: string | null;
}) {
  const snapshot = useActions();
  const projects = useStore((state) => state.projectRegistry.projects);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const sessions = useStore((state) => state.sessions);
  const [chosen, setChosen] = useState<string | null>(rememberedProjectId);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const host = actionHost();
  const placementVersion = useRailPlacementVersion(host);

  useEffect(() => { ensureLoaded(); }, []);

  const known = (id: string | null | undefined) => !!id && projects.some((project) => project.id === id);
  const projectId = known(chosen) ? chosen : known(shellProjectId) ? shellProjectId : known(activeProjectId) ? activeProjectId : projects[0]?.id ?? null;
  const project = projects.find((item) => item.id === projectId) ?? null;
  // A press runs in the open chat's checkout when that chat is in this project.
  const sessionId = activeSessionId && sessions.some((session) => session.id === activeSessionId && session.projectId === projectId)
    ? activeSessionId
    : null;
  const surface = useActionSurface({ projectId, sessionId });
  const groups = useMemo(() => groupActions(snapshot.actions, projectId), [snapshot.actions, projectId]);
  const allProjectRuns = useMemo(() => snapshot.runs.filter((run) => run.projectId === projectId), [snapshot.runs, projectId]);
  const projectRuns = useMemo(() => allProjectRuns.slice(0, 6), [allProjectRuns]);

  const empty = snapshot.status === "ready" && groups.project.length === 0 && groups.global.length === 0;
  // One placement read per action per placement change, not per tile per tick.
  const railByAction = useMemo(() => {
    const map = new Map<string, boolean | null>();
    for (const action of snapshot.actions) {
      map.set(action.id, host && activeProjectId && actionAvailableIn(action, activeProjectId) ? railState(host, action.id) : null);
    }
    return map;
  }, [snapshot.actions, activeProjectId, host, placementVersion]);
  const views = new Map(snapshot.actions.map((action) => [action.id, tileView(snapshot, action.id, projectId, Date.now())]));
  const ticking = [...views.values()].some(tileIsTransient) || projectRuns.some((run) => run.status === "running");
  const now = useNow(ticking);

  useEffect(() => { if (empty || !snapshot.canManage) setEditing(false); }, [empty, snapshot.canManage]);

  // A notice's "Show output" lands here.
  useEffect(() => {
    if (!snapshot.focusRunId || variant !== "window") return;
    surface.openRun(snapshot.focusRunId, null);
    focusRun(null);
  }, [snapshot.focusRunId]);

  const pick = (id: string) => {
    rememberedProjectId = id || null;
    setChosen(id || null);
  };

  const canRun = snapshot.canRun && !!projectId;
  const canManage = snapshot.canManage;
  const addTileHere = variant === "window" && canManage && !editing;

  const menuFor = (action: CustomActionDto, scope: Scope, index: number, peers: readonly CustomActionDto[]): MenuEntry[] => {
    const view = views.get(action.id);
    const entries: MenuEntry[] = [];
    if (canRun) {
      entries.push(view?.run && (view.state === "running" || view.state === "chat")
        ? { id: "output", label: tr("customaction.showOutput"), icon: ShowIcon, onSelect: () => surface.openRun(view.run!.id, null) }
        : { id: "run", label: tr("customaction.menu.run"), icon: PlayIcon, onSelect: () => surface.press(action, null) });
      if (view?.run && view.state !== "running" && view.state !== "chat") {
        entries.push({ id: "last", label: tr("customaction.menu.lastOutput"), icon: ShowIcon, onSelect: () => surface.openRun(view.run!.id, null) });
      }
    }
    // The rail is the person's own layout of the open project: offered only
    // where the action applies and the host can place launchers. Another
    // project's rail is not this window's to change.
    const onRail = railByAction.get(action.id) ?? null;
    if (canRun && onRail !== null && host) {
      if (entries.length) entries.push("separator");
      const here = projectId === activeProjectId;
      const other = project?.name ?? "";
      entries.push(onRail
        ? { id: "rail", label: tr("customaction.menu.removeFromRail"), icon: HideIcon, disabled: !here, ...(here ? {} : { detail: tr("customaction.menu.openToRemoveRail", { project: other }) }), onSelect: () => setOnRail(host, action.id, false) }
        : { id: "rail", label: tr("customaction.menu.addToRail"), icon: PinIcon, disabled: !here, ...(here ? {} : { detail: tr("customaction.menu.openToAddRail", { project: other }) }), onSelect: () => setOnRail(host, action.id, true) });
    }
    if (canManage) {
      if (entries.length) entries.push("separator");
      entries.push(
        { id: "edit", label: tr("customaction.menu.edit"), icon: EditIcon, onSelect: () => surface.edit(action) },
        {
          id: "duplicate",
          label: tr("customaction.menu.duplicate"),
          icon: CopyIcon,
          onSelect: () => surface.create({ ...action, name: tr("customaction.menu.copyName", { name: action.name }) }),
        },
      );
      if (scope === "project" || project) {
        entries.push({
          id: "scope",
          label: scope === "project" ? tr("customaction.menu.makeGlobal") : tr("customaction.menu.makeLocal", { project: project?.name ?? "" }),
          icon: GlobeIcon,
          onSelect: () => {
            const { id: _id, createdAt: _c, updatedAt: _u, ...input } = action;
            void saveAction({ ...input, projectId: scope === "project" ? null : projectId }, action.id).catch(showError);
          },
        });
      }
      if (index > 0) entries.push({ id: "earlier", label: tr("customaction.menu.moveEarlier"), icon: ChevronLeftIcon, onSelect: () => move(action, index - 1) });
      if (index < peers.length - 1) entries.push({ id: "later", label: tr("customaction.menu.moveLater"), icon: ChevronRightIcon, onSelect: () => move(action, index + 1) });
      entries.push("separator", {
        id: "delete",
        label: tr("customaction.delete"),
        icon: DeleteIcon,
        danger: true,
        onSelect: () => void confirmDelete(action),
      });
    }
    return entries;
  };

  const showError = (cause: unknown) => {
    const host = actionHost();
    host?.errors.show?.(host.errors.friendly(tr("customaction.error.save"), cause));
  };

  const move = (action: CustomActionDto, toIndex: number) => {
    void reorderActions(moveWithinScope(snapshot.actions, action.id, toIndex)).catch(showError);
  };

  const confirmDelete = async (action: CustomActionDto) => {
    const ok = await confirmAlert(tr("customaction.editor.deleteBody", { name: action.name }), {
      title: tr("customaction.editor.deleteTitle"),
      confirmLabel: tr("customaction.delete"),
      destructive: true,
    });
    if (ok) void deleteAction(action.id).catch(showError);
  };

  // Mouse drag only: on touch a long press opens the menu, which has Move.
  const fineDrag = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
  const dragHandlers = (action: CustomActionDto, scope: Scope, peers: readonly CustomActionDto[]) => canManage && fineDrag ? {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", action.name);
      setDrag({ id: action.id, scope });
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!drag || drag.scope !== scope || drag.id === action.id) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const side = variant === "settings"
        ? (event.clientY < rect.top + rect.height / 2 ? "before" : "after")
        : (event.clientX < rect.left + rect.width / 2 ? "before" : "after");
      if (drop?.id !== action.id || drop.side !== side) setDrop({ id: action.id, side });
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (!drag || drag.scope !== scope || !drop) return;
      const others = peers.filter((peer) => peer.id !== drag.id);
      const target = others.findIndex((peer) => peer.id === drop.id);
      if (target >= 0) move(snapshot.actions.find((item) => item.id === drag.id)!, target + (drop.side === "after" ? 1 : 0));
      setDrag(null);
      setDrop(null);
    },
    onDragEnd: () => {
      setDrag(null);
      setDrop(null);
    },
  } : {};

  const renderSection = (scope: Scope, actions: readonly CustomActionDto[], options: { headed: boolean; addTile: boolean }) => {
    const title = scope === "project"
      ? (project ? tr("customaction.section.project", { project: project.name }) : tr("customaction.section.thisProject"))
      : tr("customaction.section.global");
    const heading = (
      <span className="ca-section-heading">
        {scope === "project" && project ? <ProjectGlyph project={project} /> : <Icon icon={GlobeIcon} size="sm" />}
        <span>{title}</span>
        <span className="ca-section-count">{actions.length}</span>
      </span>
    );
    const body = (
      <div className={variant === "settings" ? "ca-rows" : "ca-grid"} role="list" aria-label={title}>
        {actions.map((action, index) => {
          const view = views.get(action.id) ?? { state: "idle" as const };
          return (
            <div
              role="listitem"
              key={action.id}
              className="ca-cell"
              data-dragging={drag?.id === action.id || undefined}
              style={{ "--ca-i": Math.min(index, 12) } as CSSProperties}
            >
              <ActionTile
                action={action}
                view={view}
                now={now}
                variant={variant === "settings" ? "row" : "tile"}
                disabled={variant === "settings" || editing ? !canManage : !canRun}
                {...(variant !== "settings" && !canRun ? { disabledReason: snapshot.blocked ?? tr("customaction.chooseProjectFirst") } : {})}
                menu={menuFor(action, scope, index, actions)}
                onPress={(anchor) => variant === "settings" || editing ? surface.edit(action) : surface.press(action, anchor)}
                editing={editing}
                capabilityId={actionCapabilityId(action.id)}
                dropSide={drop?.id === action.id ? drop.side : null}
                {...(variant === "settings" ? { detail: <code className="ca-row-command">{action.command.split("\n")[0]}</code> } : {})}
                {...dragHandlers(action, scope, actions)}
              />
            </div>
          );
        })}
        {options.addTile && (
          <div role="listitem" className="ca-cell" style={{ "--ca-i": Math.min(actions.length, 12) } as CSSProperties}>
            <button type="button" className="ca-add-tile" onClick={() => surface.create(null)}>
              <span className="ca-add-mark" aria-hidden="true"><Icon icon={AddIcon} size="md" /></span>
              <span className="ca-add-label">{tr("customaction.new")}</span>
            </button>
          </div>
        )}
      </div>
    );
    if (variant === "settings") {
      return (
        <Section
          key={scope}
          title={heading}
          {...(scope === "global" ? { hint: tr("customaction.section.globalHint") } : {})}
        >
          {body}
        </Section>
      );
    }
    return (
      <section key={scope} className="ca-section" aria-label={title}>
        {options.headed && <h3 className="ca-section-title">{heading}</h3>}
        {body}
      </section>
    );
  };

  return (
    <div className="custom-actions" data-variant={variant}>
      {variant === "settings" && <PageHead blurb={tr("customaction.settings.blurb")} />}
      <div className="ca-toolbar">
        <ProjectPicker
          label={tr("customaction.project")}
          ariaLabel={tr("customaction.projectPicker")}
          projects={projects}
          value={projectId}
          onPick={pick}
          className="ca-project-picker"
          placeholder={tr("customaction.noProject")}
          emptyMessage={tr("customaction.noProjects")}
        />
        <span className="ca-toolbar-spacer" />
        {canManage && variant === "window" && !empty && snapshot.status === "ready" && (
          <Button
            variant={editing ? "quiet" : "ghost"}
            size="sm"
            iconStart={editing ? CheckIcon : EditIcon}
            aria-pressed={editing}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? tr("customaction.done") : tr("customaction.editMode")}
          </Button>
        )}
        {canManage && !empty && (
          <Button variant={variant === "window" ? "ghost" : "primary"} size="sm" iconStart={AddIcon} onClick={() => surface.create(null)} className="ca-new">
            {tr("customaction.new")}
          </Button>
        )}
      </div>
      {editing && <p className="ca-edit-hint" role="status">{tr("customaction.editHint")}</p>}

      {snapshot.blocked && <Notice tone="warning">{snapshot.blocked}</Notice>}
      {snapshot.status === "error" && (
        <Notice
          tone="error"
          actions={<Button size="sm" variant="quiet" onClick={() => void refresh()}>{tr("customaction.retry")}</Button>}
        >
          {snapshot.error}
        </Notice>
      )}

      {(snapshot.status === "loading" || snapshot.status === "idle") && (
        <div className="ca-grid" aria-busy="true" aria-label={tr("customaction.loading")}>
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} shape="block" className="ca-skeleton" />)}
        </div>
      )}

      {empty && (
        <div className="ca-empty">
          <div className="ca-empty-mark" aria-hidden="true">
            <ActionGlyph icon="zap" color="accent" size="xl" />
          </div>
          <h2 className="ca-empty-title">{tr("customaction.empty.title")}</h2>
          <p className="ca-empty-body">{tr("customaction.empty.body")}</p>
          {canManage && (
            <>
              <Button variant="primary" iconStart={AddIcon} onClick={() => surface.create(null)}>{tr("customaction.new")}</Button>
              <p className="ca-empty-or">{tr("customaction.empty.templates")}</p>
              <div className="ca-templates">
                {ACTION_TEMPLATES.map((template) => {
                  const seed = template.seed();
                  return (
                    <button key={template.id} type="button" className="ca-template" onClick={() => surface.create(seed)}>
                      <ActionGlyph icon={seed.icon ?? "zap"} color={seed.color ?? "accent"} size="md" />
                      <span className="ca-template-copy">
                        <span className="ca-template-name">{seed.name}</span>
                        <code className="ca-template-command">{seed.command}</code>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {snapshot.status === "ready" && !empty && (
        <>
          {/* Empty scopes stay quiet: a heading only appears when it tells two
              groups apart; the add tile (window) is the way to make the next one. */}
          {project && groups.project.length > 0 && renderSection("project", groups.project, {
            headed: variant === "settings" || groups.global.length > 0,
            addTile: addTileHere,
          })}
          {groups.global.length > 0 && renderSection("global", groups.global, {
            headed: true,
            addTile: addTileHere && !(project && groups.project.length > 0),
          })}
        </>
      )}

      {variant === "window" && projectRuns.length > 0 && (
        <RecentRuns
          runs={projectRuns}
          total={allProjectRuns.length}
          seen={snapshot.seen}
          now={now}
          onOpen={(runId, anchor) => surface.openRun(runId, anchor)}
        />
      )}

      {variant === "window" && sessionId && canRun && !empty && (
        <p className="ca-context-hint">{tr("customaction.contextHint")}</p>
      )}

      {surface.overlays}
    </div>
  );
}
