// EXTENSION-SEAMS slice 3: the provider-backed tab host inside the canonical
// Files surface. Owns the tab strip (open/activate/reorder/close with dirty
// guard), keyboard cycling, unavailable restoration, scoped persistence
// (<projectId>:<sessionId-or-project>), and kept-alive resource bodies.
// Resource bodies resolve ONLY through workspace/paneProviders.ts — this
// component knows no concrete resource kind. It makes no layout decisions:
// dock/expanded/full-screen geometry belongs to the surface host.
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle,
  useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import {
  activateTab, closeTab, cycleTab, deserializePane, emptyPane, markDirty, moveTab,
  openTab, reconcileAvailability, serializePane, tabId, type PaneState, type PaneTab,
} from "../../workspace/paneStore.ts";
import {
  getPaneProvider, listPaneProviders, paneProviderVersion, paneResourceAvailable,
  paneResourceTitle, subscribePaneProviders,
} from "../../workspace/paneProviders.ts";
import { PaneVisibilityContext, usePaneVisible } from "../../workspace/paneVisibility.ts";
import { tr } from "../../i18n/index.ts";
import { confirmAlert } from "../../alerts.ts";
import { Icon } from "../../icons.tsx";
import MoveControls from "../MoveControls.tsx";
import { Button } from "../ui/index.ts";

export interface PaneHostHandle {
  open(kind: string, resource: string, title?: string): void;
  /** Returns true when the tab is gone (guard passed or nothing to close). */
  close(kind: string, resource: string, opts?: { force?: boolean }): boolean;
  rename(kind: string, from: string, to: string, title: string): void;
  activeTab(): PaneTab | null;
}

/** Actions a mounted resource body may call on its own tab. */
export interface PaneActions {
  closeSelf(kind: string, resource: string): void;
  renameSelf(kind: string, from: string, to: string, title: string): void;
}
export const PaneActionsContext = createContext<PaneActions | null>(null);
export function usePaneActions(): PaneActions | null {
  return useContext(PaneActionsContext);
}

function paneStorageKey(projectId: string, sessionId: string | null): string {
  return `polyth.pane.${projectId}:${sessionId ?? "project"}`;
}

function readPersisted(projectId: string, sessionId: string | null): string | null {
  try {
    const scoped = localStorage.getItem(paneStorageKey(projectId, sessionId));
    if (scoped !== null) return scoped;
    // Compatibility: the pre-scoping record was per project only. It seeds
    // the project scope once; session scopes start fresh (copying one tab set
    // into every session would be the forbidden cross-scope leak).
    return sessionId === null ? localStorage.getItem(`polyth.pane.${projectId}`) : null;
  } catch {
    return null;
  }
}

const usePaneProviderVersion = (): number =>
  useSyncExternalStore(subscribePaneProviders, paneProviderVersion);

export interface PaneHostProps {
  projectId: string;
  sessionId: string | null;
  /** Fired when the active tab changes (coordinators sync selection to it). */
  onActiveChange?: (tab: PaneTab | null) => void;
  /** Rendered when no tab is open. */
  emptyBody?: ReactNode;
}

const PaneHost = forwardRef<PaneHostHandle, PaneHostProps>(function PaneHost(
  { projectId, sessionId, onActiveChange, emptyBody },
  ref,
) {
  const providerVersion = usePaneProviderVersion();
  const hostVisible = usePaneVisible();
  const scopeKey = paneStorageKey(projectId, sessionId);
  const [pane, setPane] = useState<PaneState>(emptyPane);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const closingIds = useRef(new Set<string>());
  const [dragTab, setDragTab] = useState<string | null>(null);
  // Keep-alive is per visited tab: a restored-but-never-activated tab loads
  // nothing until first activation.
  const [visited, setVisited] = useState<readonly string[]>([]);

  // Re-render when any provider's change source fires (dirty markers).
  const [, setProviderTick] = useState(0);
  useEffect(() => {
    const offs = listPaneProviders()
      .filter((p) => p.subscribe)
      .map((p) => p.subscribe!(() => setProviderTick((n) => n + 1)));
    return () => { for (const off of offs) off(); };
  }, [providerVersion]);

  // ---- scoped persistence ------------------------------------------------------
  useEffect(() => {
    setPane(deserializePane(readPersisted(projectId, sessionId), paneResourceAvailable));
    setVisited([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    try { localStorage.setItem(scopeKey, serializePane(pane)); } catch { /* full */ }
  }, [pane, scopeKey]);

  // Provider late registration/replacement/disposal re-resolves availability.
  useEffect(() => {
    setPane((p) => reconcileAvailability(p, paneResourceAvailable));
  }, [providerVersion]);

  const active = pane.tabs.find((t) => t.id === pane.activeId) ?? null;
  useEffect(() => {
    if (active !== null && !visited.includes(active.id)) setVisited((v) => [...v, active.id]);
  }, [active, visited]);
  useEffect(() => {
    onActiveChange?.(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.activeId, active?.unavailable]);

  const isDirty = useCallback(
    (t: PaneTab): boolean =>
      getPaneProvider(t.kind)?.dirty?.({ projectId, sessionId }, t.resource) ?? t.dirty,
    [projectId, sessionId],
  );

  const finishClose = useCallback((id: string) => {
    setPane((current) => {
      if (!current.tabs.some((x) => x.id === id)) return current;
      return closeTab(markDirty(current, id, false), id, { force: true }).state;
    });
  }, []);

  const requestClose = useCallback((id: string, opts: { force?: boolean } = {}): boolean => {
    if (closingIds.current.has(id)) return false;
    const t = paneRef.current.tabs.find((x) => x.id === id);
    if (!t) return true;
    const scope = { projectId, sessionId };
    const provider = getPaneProvider(t.kind);
    const needsGuard = !opts.force && isDirty(t);

    const runClose = async (discardFirst: boolean) => {
      closingIds.current.add(id);
      try {
        if (discardFirst) {
          const confirmed = await confirmAlert(
            tr("workspace.panehost.discardUnsavedChangesInValue", { title: t.title }),
            { title: tr("common.discardChanges"), confirmLabel: tr("common.discard") },
          );
          if (!confirmed) return;
          await provider?.discard?.(scope, t.resource);
        }
        await provider?.close?.(scope, t.resource);
        finishClose(id);
      } catch {
        // Lifecycle failed — keep the tab so the error remains visible.
      } finally {
        closingIds.current.delete(id);
      }
    };

    if (needsGuard) {
      void runClose(true);
      return false;
    }

    const closed = provider?.close?.(scope, t.resource);
    if (closed != null && typeof (closed as Promise<void>).then === "function") {
      closingIds.current.add(id);
      void Promise.resolve(closed).then(() => {
        finishClose(id);
      }).catch(() => {
        // keep the tab
      }).finally(() => {
        closingIds.current.delete(id);
      });
      return false;
    }
    finishClose(id);
    return true;
  }, [finishClose, isDirty, projectId, sessionId]);

  const openResource = useCallback((kind: string, resource: string, title?: string) => {
    setPane((p) => openTab(p, {
      id: tabId(kind, resource),
      kind: kind === "file" ? "file" : "plugin",
      resource,
      title: title ?? paneResourceTitle(kind, resource),
      ...(paneResourceAvailable(kind, resource) ? {} : { unavailable: true as const }),
    }));
  }, []);

  const renameResource = useCallback((kind: string, from: string, to: string, title: string) => {
    setPane((p) => {
      const without = closeTab(markDirty(p, tabId(kind, from), false), tabId(kind, from), { force: true }).state;
      return openTab(without, { id: tabId(kind, to), kind: kind === "file" ? "file" : "plugin", resource: to, title });
    });
    setVisited((v) => v.map((id) => (id === tabId(kind, from) ? tabId(kind, to) : id)));
  }, []);

  useImperativeHandle(ref, (): PaneHostHandle => ({
    open: openResource,
    close: (kind, resource, opts) => requestClose(tabId(kind, resource), opts),
    rename: renameResource,
    activeTab: () => paneRef.current.tabs.find((t) => t.id === paneRef.current.activeId) ?? null,
  }), [openResource, requestClose, renameResource]);

  const actions = useMemo<PaneActions>(() => ({
    closeSelf: (kind, resource) => { requestClose(tabId(kind, resource)); },
    renameSelf: (kind, from, to, title) => renameResource(kind, from, to, title),
  }), [requestClose, renameResource]);

  // ---- keyboard: tab cycling + Escape on an unavailable tab --------------------
  useEffect(() => {
    if (!hostVisible) return;
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault();
        setPane((p) => cycleTab(p, e.key === "PageDown" ? 1 : -1));
      } else if (e.key === "Escape" && active?.unavailable) {
        requestClose(active.id);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [hostVisible, active, requestClose]);

  const bodies = pane.tabs.filter((t) => !t.unavailable && (t.id === pane.activeId || visited.includes(t.id)));

  return (
    <section className="editor-pane">
      {pane.tabs.length > 0 && (
        <div className="pane-tabs ui-scroll-tabs" role="tablist" aria-label={tr("workspace.panehost.openResources")}>
          {pane.tabs.map((t, index) => (
            <div
              key={t.id}
              role="presentation"
              className={`pane-tab-group${pane.activeId === t.id ? " active" : ""}`}
              draggable
              onDragStart={() => setDragTab(t.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragTab && dragTab !== t.id) {
                  setPane((p) => moveTab(p, dragTab, p.tabs.findIndex((x) => x.id === t.id)));
                }
                setDragTab(null);
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={pane.activeId === t.id}
                tabIndex={pane.activeId === t.id ? 0 : -1}
                className={`pane-tab${pane.activeId === t.id ? " active" : ""}${t.unavailable ? " unavailable" : ""}`}
                title={t.resource}
                onClick={() => setPane((p) => activateTab(p, t.id))}
                onKeyDown={(e) => {
                  if (e.key === "Delete") requestClose(t.id);
                }}
                onAuxClick={(e) => { if (e.button === 1) requestClose(t.id); }}
              >
                <span className="pane-tab-title">{t.title}</span>
                {isDirty(t) && <span className="pane-tab-dirty" title={tr("workspace.panehost.unsavedChanges")}>•</span>}
              </button>
              <MoveControls
                label={t.title}
                index={index}
                count={pane.tabs.length}
                previousLabel={tr("mobile.herowidgets.moveValueUp", { value: t.title })}
                nextLabel={tr("mobile.herowidgets.moveValueDown", { value: t.title })}
                onMove={(targetIndex) => setPane((p) => moveTab(p, t.id, targetIndex))}
              />
              <button
                className="pane-tab-close"
                title={tr("workspace.panehost.closeTab")}
                aria-label={tr("workspace.panehost.closeValue", { title: t.title })}
                onClick={() => requestClose(t.id)}
              >
                <Icon.close />
              </button>
            </div>
          ))}
        </div>
      )}

      {active?.unavailable && (
        <div className="editor-empty">
          <p className="muted">{tr("workspace.panehost.thisTabIsUnavailable")}</p>
          <p className="muted editor-empty-hint">
            {tr("workspace.panehost.itWasContributedByAPluginThat")}</p>
          <Button size="sm" onClick={() => requestClose(active.id)}>{tr("workspace.panehost.closeTab")}</Button>
        </div>
      )}

      <PaneActionsContext.Provider value={actions}>
        {bodies.map((t) => {
          const provider = getPaneProvider(t.kind);
          const isActive = t.id === pane.activeId;
          if (!provider) return null;
          const Body = provider.component;
          return (
            <div
              key={t.id}
              className="pane-body"
              hidden={!isActive}
              inert={!isActive}
              aria-hidden={!isActive || undefined}
            >
              <PaneVisibilityContext.Provider value={hostVisible && isActive}>
                <Body
                  projectId={projectId}
                  sessionId={sessionId}
                  resource={t.resource}
                  visible={hostVisible && isActive}
                />
              </PaneVisibilityContext.Provider>
            </div>
          );
        })}
      </PaneActionsContext.Provider>

      {active === null && emptyBody}
    </section>
  );
});

export default PaneHost;
