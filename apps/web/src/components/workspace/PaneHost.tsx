// EXTENSION-SEAMS slice 3: the provider-backed tab host inside the canonical
// Files surface. Owns the tab strip (open/activate/reorder/close with dirty
// guard), keyboard cycling, unavailable restoration, scoped persistence
// (<projectId>:<sessionId-or-project>), and kept-alive resource bodies.
// Resource bodies resolve ONLY through workspace/paneProviders.ts — this
// component knows no concrete resource kind. It makes no layout decisions:
// dock/expanded/full-screen geometry belongs to the surface host.
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle,
  useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode,
} from "react";
import {
  activateTab, closeTab, cycleTab, deserializePane, markDirty, moveTab,
  openTab, pinTab, reconcileAvailability, serializePane, tabId, type PaneState, type PaneTab,
} from "../../workspace/paneStore.ts";
import {
  getPaneProvider, listPaneProviders, paneProviderVersion, paneResourceAvailable,
  paneResourceTitle, subscribePaneProviders, type PaneTabMarker,
} from "../../workspace/paneProviders.ts";
import { PaneVisibilityContext, usePaneVisible } from "../../workspace/paneVisibility.ts";
import { tr } from "../../i18n/index.ts";
import { confirmAlert } from "../../alerts.ts";
import { Icon } from "../../icons.tsx";
import MoveControls from "../MoveControls.tsx";
import { Button, ResponsiveOverlay } from "../ui/index.ts";
import { workspacePresentationKey } from "../../reliabilityContext.ts";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../../projectPresentationSync.ts";

export interface PaneHostHandle {
  /** `background` adds the tab without taking focus from the active one. */
  open(kind: string, resource: string, title?: string, options?: { preview?: boolean; repositoryId?: string; background?: boolean }): void;
  pin(kind: string, resource: string, repositoryId?: string): void;
  /** Returns true when the tab is gone (guard passed or nothing to close). */
  close(kind: string, resource: string, opts?: { force?: boolean; repositoryId?: string }): boolean;
  rename(kind: string, from: string, to: string, title: string, repositoryId?: string): void;
  activeTab(): PaneTab | null;
  /** Opens the open-resources switcher (compact layouts hide the tab strip). */
  showSwitcher(): void;
}

/** Actions a mounted resource body may call on its own tab. */
export interface PaneActions {
  closeSelf(kind: string, resource: string, repositoryId?: string): void;
  renameSelf(kind: string, from: string, to: string, title: string, repositoryId?: string): void;
}
export const PaneActionsContext = createContext<PaneActions | null>(null);
export function usePaneActions(): PaneActions | null {
  return useContext(PaneActionsContext);
}

export function paneStorageKey(projectId: string, sessionId: string | null): string {
  return workspacePresentationKey("pane", projectId, sessionId);
}

function readPersisted(projectId: string, sessionId: string | null): string | null {
  try {
    // Unscoped legacy records cannot prove account or Space ownership.
    return localStorage.getItem(paneStorageKey(projectId, sessionId));
  } catch {
    return null;
  }
}

const usePaneProviderVersion = (): number =>
  useSyncExternalStore(subscribePaneProviders, paneProviderVersion);

export interface PaneHostProps {
  projectId: string;
  sessionId: string | null;
  /** Surface-owned labels disambiguate equal titles without changing keys. */
  repositoryLabels?: Readonly<Record<string, string>>;
  /** Fired when the active tab changes (coordinators sync selection to it). */
  onActiveChange?: (tab: PaneTab | null) => void;
  /** Fired when the number of open tabs changes (compact switcher badges). */
  onTabCountChange?: (count: number) => void;
  /** Visible name of the open-resources switcher; defaults to the generic one. */
  switcherLabel?: string;
  /** Rendered when no tab is open. */
  emptyBody?: ReactNode;
}

const ScopedPaneHost = forwardRef<PaneHostHandle, PaneHostProps>(function ScopedPaneHost(
  { projectId, sessionId, repositoryLabels, onActiveChange, onTabCountChange, switcherLabel, emptyBody },
  ref,
) {
  const providerVersion = usePaneProviderVersion();
  const hostVisible = usePaneVisible();
  const scopeKey = paneStorageKey(projectId, sessionId);
  const [pane, setPaneState] = useState<PaneState>(() => deserializePane(readPersisted(projectId, sessionId), paneResourceAvailable));
  const paneRef = useRef(pane);
  const setPane = useCallback((next: PaneState | ((current: PaneState) => PaneState)) => {
    const value = typeof next === "function" ? next(paneRef.current) : next;
    paneRef.current = value;
    setPaneState(value);
  }, []);
  const closingIds = useRef(new Set<string>());
  const previewReleases = useRef(new Map<string, Promise<void>>());
  const openSequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; openSequence.current++; };
  }, []);
  const [dragTab, setDragTab] = useState<string | null>(null);
  // Keep-alive is per visited tab: a restored-but-never-activated tab loads
  // nothing until first activation.
  const [visited, setVisited] = useState<readonly string[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Re-render when any provider's change source fires (dirty markers).
  const [, setProviderTick] = useState(0);
  useEffect(() => {
    const offs = listPaneProviders()
      .filter((p) => p.subscribe)
      .map((p) => p.subscribe!(() => {
        // Observe the dirty transition synchronously: an immediate autosave
        // must not turn a file the user edited back into a replaceable preview.
        setPane((current) => current.tabs.reduce((next, tab) =>
          tab.kind === p.kind && p.dirty?.({ projectId, sessionId, repositoryId: tab.repositoryId }, tab.resource)
            ? markDirty(next, tab.id, true) : next, current));
        setProviderTick((n) => n + 1);
      }));
    return () => { for (const off of offs) off(); };
  }, [providerVersion, projectId, sessionId, setPane]);

  // ---- scoped persistence ------------------------------------------------------
  useEffect(() => {
    try {
      localStorage.setItem(scopeKey, serializePane(pane));
      markProjectPresentationChanged(projectId, "workspaceState");
    } catch { /* full */ }
  }, [pane, projectId, scopeKey]);

  useEffect(() => {
    const onHydrated = (event: Event): void => {
      if (projectPresentationEventProjectId(event) !== projectId || !projectPresentationEventHasKey(event, "workspaceState")) return;
      setPane(deserializePane(readPersisted(projectId, sessionId), paneResourceAvailable));
    };
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }, [projectId, sessionId, setPane]);

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
  useEffect(() => {
    onTabCountChange?.(pane.tabs.length);
    if (pane.tabs.length === 0) setSwitcherOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.tabs.length]);

  const isDirty = useCallback(
    (t: PaneTab): boolean =>
      getPaneProvider(t.kind)?.dirty?.({ projectId, sessionId, repositoryId: t.repositoryId }, t.resource) ?? t.dirty,
    [projectId, sessionId],
  );
  const markerOf = (t: PaneTab): PaneTabMarker | null => {
    if (t.unavailable) return null;
    try {
      const marker = getPaneProvider(t.kind)?.marker?.({ projectId, sessionId, repositoryId: t.repositoryId }, t.resource) ?? null;
      return marker && marker.tones.length > 0 ? marker : null;
    } catch {
      return null;
    }
  };
  const renderMarker = (marker: PaneTabMarker | null) => marker && (
    <span className="pane-tab-marker" title={marker.label} role="img" aria-label={marker.label}>
      {marker.tones.slice(0, 3).map((tone, index) => (
        <span key={index} className="pane-tab-marker-dot" style={{ "--pane-tab-marker": tone } as CSSProperties} />
      ))}
    </span>
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
    const scope = { projectId, sessionId, repositoryId: t.repositoryId };
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

  const openResource = useCallback((kind: string, resource: string, title?: string, options: { preview?: boolean; repositoryId?: string; background?: boolean } = {}) => {
    // Background opens never supersede a pending foreground open.
    const sequence = options.background ? openSequence.current : ++openSequence.current;
    const id = tabId(kind, resource, options.repositoryId);
    const apply = () => {
      if (!mounted.current || sequence !== openSequence.current) return;
      let current = paneRef.current;
      for (const tab of current.tabs) {
        if (isDirty(tab)) current = markDirty(current, tab.id, true);
      }
      const next = openTab(current, {
        id, kind, resource,
        ...(options.repositoryId ? { repositoryId: options.repositoryId } : {}),
        title: title ?? paneResourceTitle(kind, resource),
        ...(options.preview ? { preview: true } : {}),
        ...(paneResourceAvailable(kind, resource) ? {} : { unavailable: true as const }),
      }, { background: options.background === true });
      const replaced = current.tabs.find((tab) => !next.tabs.some((candidate) => candidate.id === tab.id));
      setPane(next);
      if (!replaced) return;
      setVisited((ids) => ids.filter((value) => value !== replaced.id));
      // The removed body cannot receive more edits. Reopening waits for its
      // persistence gate, so a late close cannot destroy the new document.
      const restore = () => {
        if (!mounted.current) return;
        setPane((state) => state.tabs.some((tab) => tab.id === replaced.id) ? state : {
          ...state, tabs: [...state.tabs, { ...replaced, preview: false }],
        });
      };
      try {
        const release = getPaneProvider(replaced.kind)?.close?.({ projectId, sessionId, repositoryId: replaced.repositoryId }, replaced.resource);
        if (release && typeof release.then === "function") {
          const pending = Promise.resolve(release).catch(restore).finally(() => {
            if (previewReleases.current.get(replaced.id) === pending) previewReleases.current.delete(replaced.id);
          });
          previewReleases.current.set(replaced.id, pending);
        }
      } catch { restore(); }
    };
    const pending = previewReleases.current.get(id);
    if (pending) void pending.then(apply);
    else apply();
  }, [isDirty, projectId, sessionId, setPane]);

  const renameResource = useCallback((kind: string, from: string, to: string, title: string, repositoryId?: string) => {
    setPane((p) => {
      const without = closeTab(markDirty(p, tabId(kind, from, repositoryId), false), tabId(kind, from, repositoryId), { force: true }).state;
      return openTab(without, { id: tabId(kind, to, repositoryId), kind, resource: to, title, ...(repositoryId ? { repositoryId } : {}) });
    });
    setVisited((v) => v.map((id) => (id === tabId(kind, from, repositoryId) ? tabId(kind, to, repositoryId) : id)));
  }, []);

  useImperativeHandle(ref, (): PaneHostHandle => ({
    open: openResource,
    pin: (kind, resource, repositoryId) => setPane((current) => pinTab(current, tabId(kind, resource, repositoryId))),
    close: (kind, resource, opts) => requestClose(tabId(kind, resource, opts?.repositoryId), opts),
    rename: renameResource,
    activeTab: () => paneRef.current.tabs.find((t) => t.id === paneRef.current.activeId) ?? null,
    showSwitcher: () => { if (paneRef.current.tabs.length > 0) setSwitcherOpen(true); },
  }), [openResource, requestClose, renameResource]);

  const actions = useMemo<PaneActions>(() => ({
    closeSelf: (kind, resource, repositoryId) => { requestClose(tabId(kind, resource, repositoryId)); },
    renameSelf: (kind, from, to, title, repositoryId) => renameResource(kind, from, to, title, repositoryId),
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
      <ResponsiveOverlay
        open={switcherOpen && pane.tabs.length > 0}
        onClose={() => setSwitcherOpen(false)}
        title={switcherLabel ?? tr("workspace.panehost.openResources")}
        phone="sheet"
        sheetSize="tall"
        className="pane-mobile-files-sheet"
      >
        <div className="pane-mobile-files-list" role="list" aria-label={switcherLabel ?? tr("workspace.panehost.openResources")}>
          {pane.tabs.map((t) => {
            const folder = t.resource.includes("/") ? t.resource.split("/").slice(0, -1).join("/") : "";
            const repository = repositoryLabels?.[t.repositoryId ?? "primary"];
            const context = [repository && Object.keys(repositoryLabels ?? {}).length > 1 ? repository : "", folder].filter(Boolean).join(" · ");
            return (
              <div className={`pane-mobile-file-row${t.id === pane.activeId ? " active" : ""}`} key={t.id} role="listitem">
                <button
                  type="button"
                  aria-current={t.id === pane.activeId ? "page" : undefined}
                  className="pane-mobile-file-select"
                  onClick={() => { setPane((p) => activateTab(p, t.id)); setSwitcherOpen(false); }}
                >
                  <span className="pane-mobile-file-text">
                    <span className="pane-mobile-file-title">
                      <span className="pane-tab-title">{t.title}</span>
                      {renderMarker(markerOf(t))}
                      {isDirty(t) && <span className="pane-tab-dirty" title={tr("workspace.panehost.unsavedChanges")}>•</span>}
                    </span>
                    {t.unavailable
                      ? <span className="pane-mobile-file-unavailable">{tr("workspace.panehost.thisTabIsUnavailable")}</span>
                      : context && <span className="pane-mobile-file-context">{context}</span>}
                  </span>
                </button>
                <button
                  type="button"
                  className="pane-mobile-file-close"
                  aria-label={tr("workspace.panehost.closeValue", { title: t.title })}
                  onClick={() => { requestClose(t.id); }}
                >
                  <Icon.close />
                </button>
              </div>
            );
          })}
        </div>
      </ResponsiveOverlay>
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
                className={`pane-tab${pane.activeId === t.id ? " active" : ""}${t.unavailable ? " unavailable" : ""}${t.preview ? " preview" : ""}`}
                title={`${repositoryLabels?.[t.repositoryId ?? "primary"] ? `${repositoryLabels[t.repositoryId ?? "primary"]} · ` : ""}${t.resource}`}
                onClick={() => setPane((p) => activateTab(p, t.id))}
                onDoubleClick={() => setPane((p) => pinTab(p, t.id))}
                onKeyDown={(e) => {
                  if (e.key === "Delete") requestClose(t.id);
                }}
                onAuxClick={(e) => { if (e.button === 1) requestClose(t.id); }}
              >
                <span className="pane-tab-title">{t.title}</span>
                {pane.tabs.some((other) => other.id !== t.id && other.title === t.title) && (
                  <span className="pane-tab-context">{[
                    repositoryLabels?.[t.repositoryId ?? "primary"] ?? t.repositoryId,
                    pane.tabs.some((other) => other.id !== t.id && other.title === t.title && (other.repositoryId ?? "primary") === (t.repositoryId ?? "primary"))
                      ? t.resource.split("/").slice(0, -1).join("/") || "." : undefined,
                  ].filter(Boolean).join(" · ")}</span>
                )}
                {renderMarker(markerOf(t))}
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
                  repositoryId={t.repositoryId}
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

// A scope change remounts the coordinator before effects run. This prevents
// an outgoing pane from being written into the incoming workspace's record.
const PaneHost = forwardRef<PaneHostHandle, PaneHostProps>(function PaneHost(props, ref) {
  return <ScopedPaneHost key={paneStorageKey(props.projectId, props.sessionId)} {...props} ref={ref} />;
});

export default PaneHost;
