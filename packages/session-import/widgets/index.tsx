import "./styles.css";
import { useDeferredValue, useMemo, useState } from "react";
import type { SessionProjection } from "@polyth/contracts";
import ProviderLogo from "@polyth/models/provider-logo";
import { createApiTransport, defineWebPackage } from "@polyth/web-sdk";
import {
  Button, Checkbox, Dialog, DownloadIcon, Icon, LoaderIcon, Notice, Progress, SearchIcon, Spinner, TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { ago } from "../../../apps/web/src/format.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { openSession, refreshSessions } from "../../../apps/web/src/init.ts";
import { upsertSession } from "../../../apps/web/src/store.ts";

const api = createApiTransport();

type SourceItem = { ref: string; title: string; updatedAt?: number };
// `total` counts every native conversation the provider listed; `imported` is
// how many Polyth already published. `items` is only what can still be picked.
type Source = {
  id: string;
  name: string;
  items: SourceItem[];
  total: number;
  imported: number;
  unavailable?: boolean;
};

/** The one session-import surface. It lists every harness that exposes a
 * source provider, so a new backend appears without touching this package, and
 * imports the selected native conversations as canonical Polyth snapshots. */
function ImportMenuEntry({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failureCount, setFailureCount] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const searchPending = query !== deferredQuery;

  const browse = async () => {
    setOpen(true);
    setLoading(true);
    setError("");
    setSelected(new Set());
    setQuery("");
    setProgress(null);
    setFailureCount(0);
    try {
      setSources(await api.get<Source[]>(
        `/api/session-import/sources?projectId=${encodeURIComponent(projectId)}`,
      ));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    if (!busy) setOpen(false);
  };

  const toggle = (ref: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };

  const visible = useMemo(
    () => {
      const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
      return sources
        .map((source) => ({
          ...source,
          items: normalizedQuery
            ? source.items.filter((item) => item.title.toLocaleLowerCase().includes(normalizedQuery))
            : source.items,
        }))
        .filter((source) => source.items.length > 0 || (source.imported > 0 && source.total === source.imported));
    },
    [sources, deferredQuery],
  );
  const available = visible.flatMap((source) => source.items);
  const allOn = available.length > 0 && available.every((item) => selected.has(item.ref));

  const toggleAll = () => {
    setSelected(allOn ? new Set() : new Set(available.map((item) => item.ref)));
  };

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
      setOpen(false);
    }
  };

  const importCount = available.filter((item) => selected.has(item.ref)).length;
  const showSearch = sources.some((source) => source.items.length > 0);

  return (
    <div className="pkg-session-import">
      <button
        type="button"
        role="menuitem"
        className="ui-menu-item pkg-session-import-trigger"
        onClick={() => void browse()}
      >
        <Icon icon={DownloadIcon} size="sm" aria-hidden="true" />
        <span className="ui-menu-item-label">{tr("importsessionsdialog.importSessions")}</span>
      </button>
      {open && (
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

            {!loading && showSearch && (
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
                {available.length === 0 && !error && (
                  <div className="empty pkg-session-import-empty">
                    {deferredQuery.trim() !== ""
                      ? tr("sidebar.noMatchingSessions")
                      : sources.length === 0
                        ? tr("sessionimport.noHarness")
                        : tr("sessionimport.empty")}
                  </div>
                )}

                {visible.map((source) => (
                  <section key={source.id} className="pkg-session-import-group" aria-label={source.name}>
                    <header className="pkg-session-import-group-head">
                      <div className="pkg-session-import-group-title">
                        <span className="pkg-session-import-harness-logo" aria-hidden="true">
                          <ProviderLogo providerID={source.id} providerName={source.name} harnessId={source.id} size="regular" />
                        </span>
                        <span>{source.name}</span>
                      </div>
                      <span className="pkg-session-import-count">{source.items.length}</span>
                    </header>
                    {source.items.length === 0 && source.imported > 0 && (
                      <p className="muted pkg-session-import-note">
                        {tr("importsessionsdialog.all")} {source.imported}{" "}
                        {tr("importsessionsdialog.alreadyImported")}
                      </p>
                    )}
                    <div className="pkg-session-import-list">
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
                  </section>
                ))}

                {sources.filter((source) => source.unavailable).map((source) => (
                  <p key={source.id} className="muted pkg-session-import-note">
                    {tr("sessionimport.unavailableValue", { name: source.name })}
                  </p>
                ))}
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default defineWebPackage((host) => () => host.slots.register({
  id: "session-import.open",
  slot: "sidebar.project.actions",
  render: (props) => <ImportMenuEntry projectId={String(props.projectId)} />,
}));
