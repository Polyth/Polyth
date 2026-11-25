// The Apps window: the person's apps as a list, and one of them running. In a
// window opened for one app (`openPaneWindow`) it is that app alone, with no
// way back to the list: the window is the app.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SurfaceComponentProps, WebPackageHost } from "@polyth/web-sdk";
import PageSurface, { type PageStorageChange } from "@polyth/chat-blocks/page-surface";
import {
  Button,
  ChevronLeftIcon,
  DeleteIcon,
  EditIcon,
  EmptyState,
  IconButton,
  Menu,
  MoreIcon,
  NewWindowIcon,
  Notice,
  RefreshIcon,
  Spinner,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { dateTimeFormatter, getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import type { AppView } from "../src/apps.ts";
import { createStorageWriter, isMissing, openApp, refreshApps, useApps, type OpenedApp, type StorageWriter } from "./client.ts";
import { removeWithConfirm, renameWithPrompt, showAppWindow } from "./commands.ts";

export interface AppsPanelProps extends SurfaceComponentProps {
  host: WebPackageHost;
}

export default function AppsPanel({ host, resource, resourceSeq }: AppsPanelProps): ReactNode {
  // A window of its own shows its app and nothing else.
  const own = host.navigation.paneWindowResource?.() ?? null;
  const [openId, setOpenId] = useState<string | null>(own ?? resource ?? null);
  // Asking for an app again (after going back to the list) opens it again.
  useEffect(() => {
    if (own === null && resource) setOpenId(resource);
  }, [own, resource, resourceSeq]);

  const toList = useCallback(() => setOpenId(null), []);
  const id = own ?? openId;
  if (id !== null) {
    return <AppRunner key={id} host={host} id={id} own={own !== null} onBack={toList} />;
  }
  return <AppList host={host} onOpen={setOpenId} />;
}

function appMenu(host: WebPackageHost, app: AppView, onRemoved: () => void, withWindow: boolean): MenuEntry[] {
  return [
    ...(withWindow
      ? [{ id: "window", label: tr("pageapps.openWindow"), icon: NewWindowIcon, onSelect: () => { showAppWindow(host, app.id); } }]
      : []),
    { id: "rename", label: tr("pageapps.rename"), icon: EditIcon, onSelect: () => { void renameWithPrompt(host, app); } },
    {
      id: "remove",
      label: tr("pageapps.remove"),
      icon: DeleteIcon,
      danger: true,
      onSelect: () => { void removeWithConfirm(host, app).then((removed) => { if (removed) onRemoved(); }); },
    },
  ];
}

/** The first letter of the name, as the app's mark. */
const mark = (title: string): string => [...title.trim()][0]?.toUpperCase() ?? "?";

function AppList({ host, onOpen }: { host: WebPackageHost; onOpen(id: string): void }) {
  const { loaded, apps, error } = useApps();
  const dates = useMemo(() => dateTimeFormatter(getLocale(), { dateStyle: "medium" }), []);

  if (!loaded) {
    return <div className="pa-panel"><p className="pa-status" role="status"><Spinner size="sm" /> {tr("pageapps.loading")}</p></div>;
  }
  if (error && apps.length === 0) {
    return (
      <div className="pa-panel">
        <Notice tone="warning">{tr("pageapps.load.failed")}</Notice>
        <div><Button size="sm" onClick={() => { void refreshApps(); }}>{tr("pageapps.retry")}</Button></div>
      </div>
    );
  }
  if (apps.length === 0) {
    return (
      <div className="pa-panel">
        <EmptyState variant="panel" title={tr("pageapps.empty.title")} description={tr("pageapps.empty.description")} />
      </div>
    );
  }
  return (
    <div className="pa-panel">
      <ul className="pa-list">
        {apps.map((app) => (
          <li key={app.id} className="pa-item">
            <button type="button" className="pa-row" aria-label={tr("pageapps.open", { title: app.title })} onClick={() => onOpen(app.id)}>
              <span className="pa-mark" aria-hidden="true">{mark(app.title)}</span>
              <span className="pa-row-text">
                <span className="pa-row-title">{app.title}</span>
                <span className="pa-row-meta">
                  {tr("pageapps.version", { version: app.version })} · {tr("pageapps.updated", { date: dates.format(new Date(app.updatedAt)) })}
                </span>
              </span>
            </button>
            <div className="pa-row-tools">
              <IconButton icon={NewWindowIcon} size="sm" label={tr("pageapps.openWindow")} onClick={() => showAppWindow(host, app.id)} />
              <Menu label={tr("pageapps.more", { title: app.title })} align="end" entries={appMenu(host, app, () => {}, false)}>
                {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={tr("pageapps.more", { title: app.title })} />}
              </Menu>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "ready"; opened: OpenedApp };

function AppRunner({ host, id, own, onBack }: { host: WebPackageHost; id: string; own: boolean; onBack(): void }) {
  const { apps, loaded } = useApps();
  const [state, setState] = useState<Loaded>({ status: "loading" });
  // Grows to load the page again: Reload, or a newer version saved elsewhere.
  const [load, setLoad] = useState(0);
  const [storageFailed, setStorageFailed] = useState(false);
  const writer = useRef<StorageWriter | null>(null);

  useEffect(() => {
    let live = true;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    // What the running page stored reaches the server before the next load reads it.
    void (writer.current?.drain() ?? Promise.resolve()).then(() => openApp(id)).then(
      (opened) => {
        if (!live) return;
        writer.current?.dispose();
        writer.current = createStorageWriter(id, opened.storage, () => setStorageFailed(true));
        setStorageFailed(false);
        setState({ status: "ready", opened });
      },
      (cause: unknown) => { if (live) setState({ status: isMissing(cause) ? "missing" : "error" }); },
    );
    return () => { live = false; };
  }, [id, load]);

  // What the page stored goes out before the window does.
  useEffect(() => {
    const flush = () => writer.current?.flush();
    const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
      writer.current?.dispose();
      writer.current = null;
    };
  }, []);

  const listed = apps.find((app) => app.id === id);
  const opened = state.status === "ready" ? state.opened : null;
  // The list is the newer truth for the name and the version: a rename shows
  // at once, and a page saved again (here or on another device) is loaded.
  const app = opened ? listed ?? opened.app : null;
  const stale = opened !== null && listed !== undefined && listed.hash !== opened.app.hash;
  useEffect(() => { if (stale) setLoad((value) => value + 1); }, [stale]);
  const gone = opened !== null && loaded && listed === undefined;

  const title = app?.title ?? null;
  useEffect(() => {
    host.navigation.setPaneWindowTitle?.(title);
    return () => host.navigation.setPaneWindowTitle?.(null);
  }, [host, title]);

  const storage = useCallback(() => writer.current?.values() ?? {}, []);
  const onStorage = useCallback((change: PageStorageChange) => {
    if (change.op === "set") writer.current?.push({ op: "set", key: change.key, value: change.value });
    else if (change.op === "remove") writer.current?.push({ op: "remove", key: change.key });
    else writer.current?.push({ op: "clear" });
  }, []);

  // On a phone the window's own Back returns to the list, so the bar draws
  // no second arrow under it.
  const windowBack = host.ui.useWindowBack?.(own ? null : onBack) ?? false;
  const back = own || windowBack ? null : (
    <Button size="sm" variant="quiet" iconStart={ChevronLeftIcon} onClick={onBack}>{tr("pageapps.back")}</Button>
  );

  if (state.status === "missing" || gone) {
    return (
      <div className="pa-panel">
        {back && <div className="pa-bar">{back}</div>}
        <EmptyState variant="panel" title={tr("pageapps.missing.title")} description={tr("pageapps.missing.description")} />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="pa-panel">
        {back && <div className="pa-bar">{back}</div>}
        <Notice tone="warning">{tr("pageapps.load.failed")}</Notice>
        <div><Button size="sm" onClick={() => setLoad((value) => value + 1)}>{tr("pageapps.retry")}</Button></div>
      </div>
    );
  }
  if (!opened || !app) {
    return <div className="pa-panel"><p className="pa-status" role="status"><Spinner size="sm" /> {tr("pageapps.loading")}</p></div>;
  }
  return (
    <div className="pa-run" data-own={own ? "true" : undefined}>
      {!own && (
        <div className="pa-bar">
          {back}
          <strong className="pa-bar-title">{app.title}</strong>
          <div className="pa-bar-tools">
            <IconButton icon={RefreshIcon} size="sm" label={tr("pageapps.reload")} onClick={() => setLoad((value) => value + 1)} />
            <IconButton icon={NewWindowIcon} size="sm" label={tr("pageapps.openWindow")} onClick={() => showAppWindow(host, app.id)} />
            <Menu label={tr("pageapps.more", { title: app.title })} align="end" entries={appMenu(host, app, onBack, false)}>
              {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={tr("pageapps.more", { title: app.title })} />}
            </Menu>
          </div>
        </div>
      )}
      {storageFailed && <Notice tone="warning">{tr("pageapps.storage.failed")}</Notice>}
      <div className="pa-stage">
        <PageSurface
          // A new version or a reload is a new document, seeded with what the
          // page stored so far.
          key={`${opened.app.hash}:${load}`}
          html={opened.html}
          title={app.title}
          storage={storage}
          persistent
          onStorage={onStorage}
          className="pa-frame"
          stopped={(
            <div className="pa-panel">
              <Notice tone="warning">{tr("pageapps.stopped")}</Notice>
              <div><Button size="sm" onClick={() => setLoad((value) => value + 1)}>{tr("pageapps.reload")}</Button></div>
            </div>
          )}
        />
      </div>
    </div>
  );
}
