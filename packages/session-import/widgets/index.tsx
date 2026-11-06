import "./styles.css";
import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SessionProjection } from "@polyth/contracts";
import ProviderLogo from "@polyth/models/provider-logo";
import { createApiTransport, defineWebPackage } from "@polyth/web-sdk";
import {
  Button, Checkbox, ChevronDownIcon, ChevronRightIcon, Dialog, DownloadIcon, Icon, LoaderIcon, Notice, Progress, SearchIcon, Spinner, TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { ago } from "../../../apps/web/src/format.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { openSession, refreshSessions } from "../../../apps/web/src/init.ts";
import { upsertSession } from "../../../apps/web/src/store.ts";

const api = createApiTransport();

type SourceItem = { ref: string; title: string; updatedAt?: number };
// `total` counts every native conversation the provider listed; `imported` is
// how many Polyth already published. `items` is only what can still be picked.
// `unsupported` means the harness is registered but exposes no native source;
// `unavailable` means a source exists but listing it failed.
type Source = {
  id: string;
  name: string;
  items: SourceItem[];
  total: number;
  imported: number;
  unsupported?: boolean;
  unavailable?: boolean;
  /** Native transcripts sit under the host's one account: only its owner browses them. */
  ownerOnly?: boolean;
};

const listId = (id: string) => `pkg-session-import-list-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

// The picker lives in the shell's floating layer, so closing the project menu
// that opened it never unmounts the dialog (a footer contribution is unmounted
// with its menu). The menu only publishes the request.
let openProjectId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

function openImportDialog(projectId: string): void {
  openProjectId = projectId;
  emit();
}

function closeImportDialog(): void {
  openProjectId = null;
  emit();
}

function subscribeImportDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The project-menu row. It only opens the picker; the dialog itself is mounted
 * once in `app.layers`, so the menu can close immediately. */
export function ImportMenuEntry({ projectId, closeMenu }: { projectId: string; closeMenu?: () => void }) {
  return (
    <div className="pkg-session-import">
      <button
        type="button"
        role="menuitem"
        className="ui-menu-item pkg-session-import-trigger"
        onClick={() => {
          closeMenu?.();
          openImportDialog(projectId);
        }}
      >
        <Icon icon={DownloadIcon} size="sm" aria-hidden="true" />
        <span className="ui-menu-item-label">{tr("importsessionsdialog.importSessions")}</span>
      </button>
    </div>
  );
}

export function ImportDialogLayer() {
  const projectId = useSyncExternalStore(subscribeImportDialog, () => openProjectId, () => null);
  return projectId === null ? null : <ImportDialog key={projectId} projectId={projectId} onClose={closeImportDialog} />;
}

/** The one session-import surface. It lists every registered harness, so a new
 * backend appears without touching this package, and groups the native
 * conversations as collapsed accordions. The top filter matches any part of a
 * title and force-opens every group that still has a match. */
function ImportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failureCount, setFailureCount] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const searchPending = query !== deferredQuery;
  const searching = deferredQuery.trim() !== "";

  useEffect(() => {
    let live = true;
    api.get<Source[]>(`/api/session-import/sources?projectId=${encodeURIComponent(projectId)}`)
      .then((next) => { if (live) setSources(next); })
      .catch((cause: unknown) => { if (live) setError((cause as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId]);

  const close = () => {
    if (!busy) onClose();
  };

  const toggle = (ref: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visible = useMemo(
    () => {
      const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
      const matched = sources.map((source) => ({
        ...source,
        items: normalizedQuery
          ? source.items.filter((item) => item.title.toLocaleLowerCase().includes(normalizedQuery))
          : source.items,
      }));
      // While filtering, hide harnesses that have no matching title; otherwise
      // keep every harness visible so its name and session count stay in view.
      return matched.filter((source) => !normalizedQuery || source.items.length > 0);
    },
    [sources, deferredQuery],
  );
  const importable = visible.filter((source) => !source.unsupported && !source.unavailable && !source.ownerOnly);
  const available = importable.flatMap((source) => source.items);
  const allOn = available.length > 0 && available.every((item) => selected.has(item.ref));

  const toggleAll = () => {
    setSelected(allOn ? new Set() : new Set(available.map((item) => item.ref)));
  };

  const isOpen = (source: Source) => searching ? source.items.length > 0 : expanded.has(source.id);

  const importSelected = async () => {
    const refs = available.filter((item) => selected.has(item.ref)).map((item) => item.ref);
    if (refs.length === 0) return;
    setBusy(true);
    setError("");
    setFailureCount(0);
    setProgress({ done: 0, total: refs.length });
    let imported = 0;
    let failed = 0;
    let last: SessionProjection | null = null;
    for (const ref of refs) {
      try {
        // No request id: the server derives a stable publication identity from
        // the native source, so a second import resolves to the same session.
        const projection = await api.post<SessionProjection>("/api/session-import/snapshot", { projectId, ref });
        upsertSession(projection);
        last = projection;
        imported += 1;
      } catch {
        failed += 1;
      }
      setProgress({ done: imported + failed, total: refs.length });
    }
    await refreshSessions(projectId);
    setBusy(false);
    setProgress(null);
    setFailureCount(failed);
    // Re-list so freshly imported conversations drop out of the picker.
    const fresh = await api.get<Source[]>(
      `/api/session-import/sources?projectId=${encodeURIComponent(projectId)}`,
    ).catch(() => null);
    if (fresh) setSources(fresh);
    setSelected(new Set());
    if (failed === 0) {
      if (imported === 1 && last) await openSession(last.id);
      onClose();
    }
  };

  const importCount = available.filter((item) => selected.has(item.ref)).length;
  const showFilter = !loading && sources.length > 0;

  return (
    <Dialog
      title={tr("importsessionsdialog.importSessions")}
      className="import-sessions-dialog pkg-session-import-dialog"
      size="lg"
      onClose={close}
      footer={(
        <>
          <span className="muted pkg-session-import-hint">
            {tr("importsessionsdialog.historyLoadsTheFirstTimeAnImported")}
          </span>
          <span className="header-spacer" />
          <Button size="sm" disabled={busy} onClick={close}>{tr("common.cancel")}</Button>
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            disabled={loading || importCount === 0}
            onClick={() => void importSelected()}
          >
            {busy
              ? tr("importsessionsdialog.importing")
              : importCount > 0
                ? `${tr("importsessionsdialog.importSessions")} · ${importCount}`
                : tr("importsessionsdialog.importSessions")}
          </Button>
        </>
      )}
    >
      <div className="pkg-session-import-body">
            <p className="muted pkg-session-import-intro">{tr("sessionimport.intro")}</p>

            {progress && (
              <div className="pkg-session-import-progress">
                <Progress value={progress.done / progress.total} label={tr("importsessionsdialog.importing")} />
                <small className="muted">{progress.done} {tr("importsessionsdialog.of")} {progress.total}</small>
              </div>
            )}
            {!busy && failureCount > 0 && (
              <Notice tone="error" role="alert">
                {tr("sessionimport.failed", { count: failureCount })}
              </Notice>
            )}
            {error && <Notice tone="error" role="alert">{error}</Notice>}

            {loading && (
              <div className="pkg-session-import-loading" role="status" aria-live="polite">
                <div className="pkg-session-import-loading-label">
                  <Spinner size="sm" />
                  <span>{tr("common.loading")}</span>
                </div>
                <div className="pkg-session-import-loading-group" aria-hidden="true">
                  <span className="pkg-session-import-skeleton pkg-session-import-skeleton--heading" />
                  <span className="pkg-session-import-skeleton" />
                  <span className="pkg-session-import-skeleton" />
                  <span className="pkg-session-import-skeleton pkg-session-import-skeleton--short" />
                </div>
              </div>
            )}

            {showFilter && (
              <div
                className="pkg-session-import-search"
                data-searching={searchPending || undefined}
                aria-busy={searchPending || undefined}
              >
                <Icon icon={searchPending ? LoaderIcon : SearchIcon} size="sm" className="pkg-session-import-search-icon" aria-hidden="true" />
                <TextInput
                  uiSize="sm"
                  type="search"
                  value={query}
                  placeholder={tr("sessionimport.search")}
                  aria-label={tr("sessionimport.search")}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {searchPending && <span className="pkg-session-import-search-status" role="status">{tr("common.loading")}</span>}
              </div>
            )}

            {!loading && !error && available.length > 0 && (
              <Checkbox
                className="pkg-session-import-row pkg-session-import-all"
                checked={allOn}
                onChange={toggleAll}
                label={(
                  <>
                    <strong>{tr("importsessionsdialog.selectAll")}</strong>{" "}
                    <small className="muted">{importCount} {tr("importsessionsdialog.of")} {available.length}</small>
                  </>
                )}
              />
            )}

            {!loading && (
              <div
                key={deferredQuery}
                className="pkg-session-import-results"
                data-searching={searchPending || undefined}
                aria-busy={searchPending || undefined}
              >
                {visible.length === 0 && !error && (
                  <div className="empty pkg-session-import-empty">
                    {searching
                      ? tr("sidebar.noMatchingSessions")
                      : sources.length === 0
                        ? tr("sessionimport.noHarness")
                        : tr("sessionimport.empty")}
                  </div>
                )}

                {visible.map((source) => {
                  if (source.unsupported || source.unavailable || source.ownerOnly) {
                    return (
                      <section key={source.id} className="pkg-session-import-group pkg-session-import-group--muted" aria-label={source.name}>
                        <header className="pkg-session-import-group-head">
                          <div className="pkg-session-import-group-title">
                            <span className="pkg-session-import-harness-logo" aria-hidden="true">
                              <ProviderLogo providerID={source.id} providerName={source.name} harnessId={source.id} size="regular" />
                            </span>
                            <span>{source.name}</span>
                          </div>
                          <span className="pkg-session-import-count">—</span>
                        </header>
                        <p className="muted pkg-session-import-note">
                          {source.ownerOnly
                            ? tr("sessionimport.ownerOnlyValue", { name: source.name })
                            : source.unsupported
                              ? tr("sessionimport.unsupportedValue", { name: source.name })
                              : tr("sessionimport.unavailableValue", { name: source.name })}
                        </p>
                      </section>
                    );
                  }
                  const open = isOpen(source);
                  const count = source.items.length;
                  return (
                    <section key={source.id} className="pkg-session-import-group pkg-session-import-group--accordion" aria-label={source.name}>
                      <button
                        type="button"
                        className="pkg-session-import-group-head pkg-session-import-group-toggle"
                        aria-expanded={open}
                        aria-controls={open ? listId(source.id) : undefined}
                        onClick={() => toggleGroup(source.id)}
                        disabled={searching}
                      >
                        <span className="pkg-session-import-group-title">
                          <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size="sm" aria-hidden="true" />
                          <span className="pkg-session-import-harness-logo" aria-hidden="true">
                            <ProviderLogo providerID={source.id} providerName={source.name} harnessId={source.id} size="regular" />
                          </span>
                          <span>{source.name}</span>
                        </span>
                        <span className="pkg-session-import-count">{count}</span>
                      </button>
                      {open && (
                        <div id={listId(source.id)} className="pkg-session-import-list" role="group" aria-label={source.name}>
                          {count === 0 && source.imported > 0 && (
                            <p className="muted pkg-session-import-note">
                              {tr("importsessionsdialog.all")} {source.imported}{" "}
                              {tr("importsessionsdialog.alreadyImported")}
                            </p>
                          )}
                          {source.items.map((item) => (
                            <Checkbox
                              key={item.ref}
                              className="pkg-session-import-row"
                              checked={selected.has(item.ref)}
                              onChange={() => toggle(item.ref)}
                              label={(
                                <span className="pkg-session-import-row-copy">
                                  <strong>{item.title || tr("sessionimport.session")}</strong>
                                  {item.updatedAt !== undefined && (
                                    <small className="muted">
                                      {tr("importsessionsdialog.updated")} {ago(item.updatedAt)} {tr("importsessionsdialog.ago")}
                                    </small>
                                  )}
                                </span>
                              )}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
    </Dialog>
  );
}

export default defineWebPackage((host) => () => {
  const off = [
    host.slots.register({
      id: "session-import.open",
      slot: "sidebar.project.actions",
      render: (props) => (
        <ImportMenuEntry
          projectId={String(props.projectId)}
          closeMenu={typeof props.closeMenu === "function" ? props.closeMenu as () => void : undefined}
        />
      ),
    }),
    host.slots.register({
      id: "session-import.dialog",
      slot: "app.layers",
      render: () => <ImportDialogLayer />,
    }),
  ];
  return () => { for (const dispose of off.toReversed()) dispose(); };
});
