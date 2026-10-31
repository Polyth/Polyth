// Placeable pieces: the icon bar for toolbars (session header, composer, top
// rail, status bar), the tile panel for the Canvas and the phone Workspace,
// and a single action's button.
import { useEffect, useMemo, useState } from "react";
import type { WidgetAvailabilityContext, WidgetRenderContext, WidgetSettingsContext } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  AddIcon,
  Button,
  Checkbox,
  Icon,
  Menu,
  MoreIcon,
  Select,
  Switch,
  ZapIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  actionAvailableIn,
  actionsForProject,
  normalizeActionInput,
  type CustomActionDto,
} from "../src/actionModel.ts";
import ActionGlyph from "./ActionGlyph.tsx";
import ActionTile from "./ActionTile.tsx";
import { actionHost } from "./host.ts";
import { ensureLoaded, getSnapshot, saveAction, startAction, useActions, type ActionsSnapshot } from "./store.ts";
import { tileIsTransient, tileView } from "./tileState.ts";
import { useNow } from "./time.ts";
import { useActionSurface } from "./useActionSurface.tsx";

const DEFAULT_MAX = 4;

interface BarConfig {
  /** Chosen action ids, in display order; absent shows every action. */
  actionIds: string[] | null;
  max: number;
  labels: boolean;
}

export function barConfig(config: Readonly<Record<string, unknown>>): BarConfig {
  const ids = Array.isArray(config.actionIds) ? config.actionIds.filter((id): id is string => typeof id === "string") : null;
  const max = typeof config.max === "number" && Number.isInteger(config.max) ? Math.min(12, Math.max(1, config.max)) : DEFAULT_MAX;
  return { actionIds: ids && ids.length ? ids : null, max, labels: config.labels === true };
}

/** The actions a bar shows in a project, in the person's order. */
export function barActions(actions: readonly CustomActionDto[], projectId: string | null, config: BarConfig): CustomActionDto[] {
  const available = actionsForProject(actions, projectId);
  if (!config.actionIds) return available;
  const byId = new Map(available.map((action) => [action.id, action]));
  return config.actionIds.flatMap((id) => byId.get(id) ?? []);
}

/** Legacy single-button config from before the shared library existed. */
interface LegacyCommand {
  label: string;
  command: string;
  icon: string;
  output: "terminal" | "popup";
}

function legacyCommand(config: Readonly<Record<string, unknown>>): LegacyCommand | null {
  if (typeof config.actionId === "string" || typeof config.command !== "string" || !config.command.trim()) return null;
  return {
    label: typeof config.label === "string" && config.label.trim() ? config.label.trim() : tr("customaction.legacy.name"),
    command: config.command,
    icon: typeof config.icon === "string" ? config.icon : "terminal",
    output: config.output === "popup" ? "popup" : "terminal",
  };
}

/** The old ten glyph ids, mapped onto the shared glyph set. */
const LEGACY_ICONS: Record<string, string> = {
  terminal: "terminal", play: "play", sparkles: "sparkles", refresh: "refresh", target: "target",
  globe: "globe", package: "package", bell: "bell", clock: "clock", send: "send",
};

const legacyAsAction = (legacy: LegacyCommand, projectId: string | null): CustomActionDto => ({
  id: "legacy",
  ...normalizeActionInput({
    name: legacy.label,
    command: legacy.command,
    icon: LEGACY_ICONS[legacy.icon] ?? "terminal",
    color: "neutral",
    mode: legacy.output === "popup" ? "background" : "terminal",
    projectId,
  }),
  createdAt: 0,
  updatedAt: 0,
});

// ---- availability (read synchronously by the widget hosts) ---------------------------

export function barAvailable(context: WidgetAvailabilityContext): boolean {
  return barActions(getSnapshot().actions, context.projectId, barConfig(context.config)).length > 0;
}

export function singleAvailable(context: WidgetAvailabilityContext): boolean {
  if (legacyCommand(context.config)) return !!context.projectId;
  const id = typeof context.config.actionId === "string" ? context.config.actionId : null;
  const action = id ? getSnapshot().actions.find((item) => item.id === id) : undefined;
  return !!action && actionAvailableIn(action, context.projectId);
}

/** Changes whenever a host's availability answer could change. Before the
 *  first load every answer is "no", so loading itself changes nothing. */
export function availabilityKey(snapshot: Pick<ActionsSnapshot, "status" | "actions">): string {
  if (snapshot.status !== "ready" && snapshot.actions.length === 0) return "pending";
  return snapshot.actions.map((action) => `${action.id}:${action.projectId ?? "*"}`).join(",") || "none";
}

// ---- bar --------------------------------------------------------------------------

function useTicking(snapshot: ActionsSnapshot, actions: readonly CustomActionDto[], projectId: string | null): number {
  const transient = actions.some((action) => tileIsTransient(tileView(snapshot, action.id, projectId, Date.now())));
  return useNow(transient);
}

export function ActionBar({ projectId, sessionId, editing, config }: WidgetRenderContext) {
  const snapshot = useActions();
  useEffect(() => { ensureLoaded(); }, []);
  const settings = barConfig(config);
  const actions = barActions(snapshot.actions, projectId, settings);
  const surface = useActionSurface({ projectId, sessionId, resultCard: true });
  const now = useTicking(snapshot, actions, projectId);
  const host = actionHost();
  const openWindow = () => host?.navigation.openWorkspacePane("custom-action");

  if (actions.length === 0) {
    if (!editing) return null;
    return (
      <span className="ca-bar" data-empty="true">
        <button type="button" className="ca-bar-placeholder" onClick={openWindow} title={tr("customaction.bar.empty")}>
          <Icon icon={ZapIcon} size="md" />
          <span>{tr("customaction.bar.emptyShort")}</span>
        </button>
      </span>
    );
  }

  const shown = actions.length > settings.max ? actions.slice(0, settings.max - 1) : actions;
  const overflow = actions.slice(shown.length);
  const blocked = !snapshot.canRun ? snapshot.blocked ?? tr("customaction.readOnly") : undefined;
  const menuFor = (action: CustomActionDto): MenuEntry[] => {
    const entries: MenuEntry[] = [];
    const view = tileView(snapshot, action.id, projectId, now);
    if (view.run) entries.push({ id: "last", label: tr("customaction.menu.lastOutput"), onSelect: () => surface.openRun(view.run!.id, null) });
    if (snapshot.canManage) entries.push({ id: "edit", label: tr("customaction.menu.edit"), onSelect: () => surface.edit(action) });
    entries.push({ id: "manage", label: tr("customaction.manage"), onSelect: openWindow });
    return entries;
  };

  return (
    <span className="ca-bar" data-labels={settings.labels || undefined} aria-label={tr("customaction.bar.label")} role="group">
      {shown.map((action) => {
        const view = tileView(snapshot, action.id, projectId, now);
        return (
          <ActionTile
            key={action.id}
            action={action}
            view={view}
            now={now}
            variant="icon"
            disabled={!!blocked || editing}
            {...(blocked ? { disabledReason: blocked } : {})}
            menu={editing ? [] : menuFor(action)}
            onPress={(anchor) => surface.press(action, anchor)}
            showName={settings.labels}
          />
        );
      })}
      {overflow.length > 0 && (
        <Menu
          label={tr("customaction.bar.more")}
          entries={[
            ...overflow.map((action): MenuEntry => ({
              id: action.id,
              label: action.name,
              icon: () => <ActionGlyph icon={action.icon} color={action.color} size="bare" state={tileView(snapshot, action.id, projectId, now).state} />,
              disabled: !!blocked || editing,
              onSelect: () => surface.press(action, null),
            })),
            "separator",
            { id: "manage", label: tr("customaction.manage"), onSelect: openWindow },
          ]}
          align="end"
        >
          {(trigger) => (
            <button {...trigger} type="button" className="ca-bar-more" aria-label={tr("customaction.bar.more")} title={tr("customaction.bar.more")}>
              <Icon icon={MoreIcon} size="md" />
            </button>
          )}
        </Menu>
      )}
      {surface.overlays}
    </span>
  );
}

export function ActionBarSettings({ config, updateConfig, projectId }: WidgetSettingsContext) {
  const snapshot = useActions();
  useEffect(() => { ensureLoaded(); }, []);
  const settings = barConfig(config);
  const available = actionsForProject(snapshot.actions, projectId);
  const chosen = new Set(settings.actionIds ?? available.map((action) => action.id));
  const update = (patch: Partial<BarConfig>) => {
    const next = { ...settings, ...patch };
    updateConfig({
      ...(next.actionIds ? { actionIds: next.actionIds } : {}),
      ...(next.max !== DEFAULT_MAX ? { max: next.max } : {}),
      ...(next.labels ? { labels: true } : {}),
    });
  };
  return (
    <div className="ca-widget-settings">
      <div className="ca-widget-setting">
        <span className="ca-field-label">{tr("customaction.bar.show")}</span>
        <label className="ca-check-row">
          <Switch checked={!settings.actionIds} onChange={(all) => update({ actionIds: all ? null : available.map((action) => action.id) })} label={tr("customaction.bar.all")} />
          <span>{tr("customaction.bar.all")}</span>
        </label>
        {settings.actionIds && (
          <div className="ca-check-list">
            {available.map((action) => (
              <Checkbox
                key={action.id}
                checked={chosen.has(action.id)}
                label={action.name}
                onChange={(on: boolean) => update({
                  actionIds: on
                    ? available.filter((item) => chosen.has(item.id) || item.id === action.id).map((item) => item.id)
                    : [...chosen].filter((id) => id !== action.id),
                })}
              />
            ))}
          </div>
        )}
      </div>
      <div className="ca-widget-setting">
        <span className="ca-field-label">{tr("customaction.bar.max")}</span>
        <Select
          label={tr("customaction.bar.max")}
          value={String(settings.max)}
          options={[2, 3, 4, 5, 6, 8, 12].map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(value) => update({ max: Number(value) })}
        />
      </div>
      <label className="ca-check-row">
        <Switch checked={settings.labels} onChange={(labels) => update({ labels })} label={tr("customaction.bar.labels")} />
        <span>{tr("customaction.bar.labels")}</span>
      </label>
      <Button size="sm" variant="quiet" onClick={() => actionHost()?.navigation.openWorkspacePane("custom-action")}>{tr("customaction.manage")}</Button>
    </div>
  );
}

// ---- panel --------------------------------------------------------------------------

export function ActionPanel({ projectId, sessionId, editing }: WidgetRenderContext) {
  const snapshot = useActions();
  useEffect(() => { ensureLoaded(); }, []);
  const actions = actionsForProject(snapshot.actions, projectId);
  const surface = useActionSurface({ projectId, sessionId });
  const now = useTicking(snapshot, actions, projectId);
  const blocked = !snapshot.canRun ? snapshot.blocked ?? tr("customaction.readOnly") : undefined;

  if (snapshot.status !== "ready" && actions.length === 0) {
    return <div className="custom-actions ca-panel" aria-busy="true" />;
  }
  return (
    <div className="custom-actions ca-panel">
      {actions.length === 0 ? (
        <div className="ca-panel-empty">
          <ActionGlyph icon="zap" color="accent" size="md" />
          <p>{projectId ? tr("customaction.panel.empty") : tr("customaction.chooseProjectFirst")}</p>
          {snapshot.canManage && projectId && (
            <Button size="sm" variant="quiet" iconStart={AddIcon} disabled={editing} onClick={() => surface.create(null)}>{tr("customaction.new")}</Button>
          )}
        </div>
      ) : (
        <div className="ca-grid" role="list">
          {actions.map((action) => (
            <div role="listitem" key={action.id} className="ca-cell">
              <ActionTile
                action={action}
                view={tileView(snapshot, action.id, projectId, now)}
                now={now}
                variant="tile"
                disabled={!!blocked || editing}
                {...(blocked ? { disabledReason: blocked } : {})}
                menu={editing ? [] : [
                  ...(snapshot.canManage ? [{ id: "edit", label: tr("customaction.menu.edit"), onSelect: () => surface.edit(action) }] : []),
                  { id: "manage", label: tr("customaction.manage"), onSelect: () => actionHost()?.navigation.openWorkspacePane("custom-action") },
                ]}
                onPress={(anchor) => surface.press(action, anchor)}
              />
            </div>
          ))}
        </div>
      )}
      {surface.overlays}
    </div>
  );
}

// ---- single action ----------------------------------------------------------------------

export function SingleAction({ projectId, sessionId, editing, config }: WidgetRenderContext) {
  const snapshot = useActions();
  useEffect(() => { ensureLoaded(); }, []);
  const legacy = legacyCommand(config);
  const id = typeof config.actionId === "string" ? config.actionId : null;
  const stored = id ? snapshot.actions.find((action) => action.id === id) : undefined;
  const action = stored && actionAvailableIn(stored, projectId) ? stored : legacy ? legacyAsAction(legacy, projectId) : undefined;
  const surface = useActionSurface({ projectId, sessionId, resultCard: true });
  const now = useTicking(snapshot, action ? [action] : [], projectId);
  if (!action) {
    if (!editing) return null;
    return (
      <span className="ca-bar" data-empty="true">
        <span className="ca-bar-placeholder"><Icon icon={ZapIcon} size="md" /><span>{tr("customaction.single.choose")}</span></span>
      </span>
    );
  }
  const blocked = !snapshot.canRun ? snapshot.blocked ?? tr("customaction.readOnly") : undefined;
  return (
    <span className="ca-bar">
      <ActionTile
        action={action}
        view={tileView(snapshot, action.id, projectId, now)}
        now={now}
        variant="icon"
        disabled={!!blocked || editing}
        {...(blocked ? { disabledReason: blocked } : {})}
        menu={editing || action.id === "legacy" ? [] : [
          ...(snapshot.canManage ? [{ id: "edit", label: tr("customaction.menu.edit"), onSelect: () => surface.edit(action) }] : []),
          { id: "manage", label: tr("customaction.manage"), onSelect: () => actionHost()?.navigation.openWorkspacePane("custom-action") },
        ]}
        onPress={(anchor) => {
          if (action.id !== "legacy") {
            surface.press(action, anchor);
            return;
          }
          // An unmigrated button keeps working the way it always did: in Terminal.
          if (!projectId) return;
          void startAction({ ...action, mode: "terminal" }, { projectId, sessionId }).catch((cause) => {
            const host = actionHost();
            host?.errors.show?.(host.errors.friendly(tr("customaction.error.start", { name: action.name }), cause));
          });
        }}
      />
      {surface.overlays}
    </span>
  );
}

export function SingleActionSettings({ config, updateConfig, projectId }: WidgetSettingsContext) {
  const snapshot = useActions();
  useEffect(() => { ensureLoaded(); }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const legacy = legacyCommand(config);
  const options = useMemo(
    () => actionsForProject(snapshot.actions, projectId).map((action) => ({ value: action.id, label: action.name })),
    [snapshot.actions, projectId],
  );
  const migrate = async () => {
    if (!legacy) return;
    setSaving(true);
    setError(null);
    try {
      const { id: _id, createdAt: _c, updatedAt: _u, ...input } = legacyAsAction(legacy, projectId);
      const saved = await saveAction(input);
      updateConfig({ actionId: saved.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="ca-widget-settings">
      {legacy && (
        <div className="ca-legacy">
          <p>{tr("customaction.legacy.body")}</p>
          <code>{legacy.command}</code>
          <Button size="sm" variant="primary" busy={saving} disabled={!snapshot.canManage} onClick={() => void migrate()}>
            {tr("customaction.legacy.migrate")}
          </Button>
          {error && <p className="ca-field-error" role="alert">{error}</p>}
        </div>
      )}
      <div className="ca-widget-setting">
        <span className="ca-field-label">{tr("customaction.single.action")}</span>
        <Select
          label={tr("customaction.single.action")}
          value={typeof config.actionId === "string" ? config.actionId : ""}
          options={options}
          placeholder={tr("customaction.single.choose")}
          onChange={(actionId) => updateConfig({ actionId })}
        />
      </div>
      <Button size="sm" variant="quiet" onClick={() => actionHost()?.navigation.openWorkspacePane("custom-action")}>{tr("customaction.manage")}</Button>
    </div>
  );
}
