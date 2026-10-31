// Main-window desktop update notice. The updater lives in the Electron main
// process and otherwise only reaches the tray menu and Settings → Desktop, so a
// release could be found, downloaded and left waiting without the user ever
// seeing it. This follows the same update state as one `update` notification
// of the shared stack: a found release (with Download, or the release page on
// manual-install builds), its download progress, and a ready update with
// Restart. Dismissing hides one stage of one version; the next stage or a
// newer version shows it again. While the desktop's small update window is on
// screen it carries the progress and the restart prompt, so this steps aside.
import { useEffect, useRef, useState } from "react";
import { desktopBridge, type DesktopUpdateState } from "./desktopBridge.ts";
import { tr } from "./i18n/index.ts";
import { dismissNotification, getNotifications, notify, updateNotification } from "./notify/store.ts";

export const DESKTOP_UPDATE_NOTICE_DISMISSED_KEY = "polyth.desktop.updateNotice.dismissed";

export type DesktopUpdateNoticeKind = "available" | "manual" | "downloading" | "downloaded" | "installing";

export interface DesktopUpdateNoticeView {
  kind: DesktopUpdateNoticeKind;
  version: string;
  /** 0..1 while downloading, when the updater reported progress. */
  progress?: number;
  /** What a dismissal of this view records. */
  dismissal: string;
}

/** Found (available/downloading) and ready (downloaded) are dismissed apart,
 *  so a download that finishes after "Later" still announces itself. */
const dismissalFor = (kind: DesktopUpdateNoticeKind, version: string): string =>
  `${kind === "downloaded" ? "ready" : kind === "installing" ? "installing" : "found"}:${version}`;

export function desktopUpdateNoticeView(state: DesktopUpdateState, dismissed: string | null): DesktopUpdateNoticeView | null {
  const version = state.version?.trim();
  if (!version || state.progressWindow === true) return null;
  let kind: DesktopUpdateNoticeKind;
  if (state.phase === "available") kind = state.installMode === "manual" ? "manual" : "available";
  else if (state.phase === "downloading") kind = "downloading";
  else if (state.phase === "downloaded") kind = "downloaded";
  // The handover (hide the main window, stop the server, start the installer)
  // can take long enough to look frozen. Keep a card until the small update
  // window takes over (it publishes progressWindow), so there is never a
  // silent gap if that window cannot appear.
  else if (state.phase === "installing") kind = "installing";
  else return null;
  const dismissal = dismissalFor(kind, version);
  if (dismissal === dismissed) return null;
  return {
    kind,
    version,
    dismissal,
    ...(kind === "downloading" && typeof state.percent === "number" && Number.isFinite(state.percent)
      ? { progress: Math.min(1, Math.max(0, state.percent / 100)) }
      : {}),
  };
}

const readDismissed = (): string | null => {
  try { return localStorage.getItem(DESKTOP_UPDATE_NOTICE_DISMISSED_KEY); } catch { return null; }
};

const writeDismissed = (value: string): void => {
  try { localStorage.setItem(DESKTOP_UPDATE_NOTICE_DISMISSED_KEY, value); } catch {}
};

export const DESKTOP_UPDATE_NOTIFICATION_ID = "host.desktop-update";

/** Drives the desktop update notification; renders nothing itself. */
export function DesktopUpdateNotice() {
  const api = desktopBridge();
  const [state, setState] = useState<DesktopUpdateState>({ phase: "idle", message: "" });
  const [dismissed, setDismissed] = useState(readDismissed);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    let live = true;
    const off = api.onUpdateState((next) => { if (live) setState(next); });
    // A release found before this window mounted (or before a reload) is
    // still announced; older shells without the getter wait for the next event.
    void api.getUpdateState?.().then((current) => { if (live) setState(current); }).catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, [api]);

  const view = api ? desktopUpdateNoticeView(state, dismissed) : null;
  // The dismissal a close records is the one of the stage on screen right then.
  const dismissal = useRef<string | null>(null);
  dismissal.current = view?.dismissal ?? null;
  // The stage (kind + version) on screen: a new stage is a fresh notification
  // (to the front, announced); progress and busy ticks only update it in place.
  const shownStage = useRef<string | null>(null);

  useEffect(() => {
    if (!api || !view) {
      shownStage.current = null;
      dismissNotification(DESKTOP_UPDATE_NOTIFICATION_ID);
      return;
    }
    const title = view.kind === "downloading"
      ? tr("desktopupdate.downloadingTitle", { version: view.version })
      : view.kind === "downloaded"
        ? tr("desktopupdate.readyTitle", { version: view.version })
        : view.kind === "installing"
          ? tr("desktopupdate.installingTitle", { version: view.version })
          : tr("desktopupdate.availableTitle", { version: view.version });
    const body = {
      available: tr("desktopupdate.availableBody"),
      manual: tr("desktopupdate.manualBody"),
      downloading: tr("desktopupdate.downloadingBody"),
      downloaded: tr("desktopupdate.readyBody"),
      installing: tr("desktopupdate.installingBody"),
    }[view.kind];
    const act = (work: () => Promise<unknown>) => {
      setBusy(true);
      return work().then(() => undefined, () => undefined).finally(() => setBusy(false));
    };
    const primary = view.kind === "downloaded"
      ? { label: tr("desktopupdate.restart"), run: () => act(() => api.installUpdate()) }
      : view.kind === "available" || view.kind === "manual"
        ? {
          label: view.kind === "manual" ? tr("desktopupdate.openReleasePage") : tr("desktopupdate.download"),
          run: () => act(() => api.downloadUpdate()),
        }
        : null;
    const content = {
      title,
      body,
      progress: view.kind === "downloading" ? view.progress ?? null : view.kind === "installing" ? null : undefined,
      actions: primary ? [{ ...primary, primary: true, keepOpen: true, busy }] : undefined,
    };
    const stage = `${view.kind}:${view.version}`;
    const onScreen = getNotifications().items.some((item) => item.id === DESKTOP_UPDATE_NOTIFICATION_ID);
    if (stage === shownStage.current && onScreen) {
      updateNotification(DESKTOP_UPDATE_NOTIFICATION_ID, content);
      return;
    }
    shownStage.current = stage;
    notify({
      id: DESKTOP_UPDATE_NOTIFICATION_ID,
      kind: view.kind === "downloading" || view.kind === "installing" ? "progress" : "update",
      ...content,
      duration: "sticky",
      // The handover is not cancellable: the window is already closing, and
      // hiding this card would leave no sign that work is still in progress.
      dismissible: view.kind !== "installing",
      dismissLabel: view.kind === "downloaded" ? tr("desktopupdate.later") : tr("desktopupdate.dismiss"),
      data: { "update-kind": view.kind },
      onDismiss: (reason) => {
        shownStage.current = null;
        if (reason !== "user" || !dismissal.current) return;
        writeDismissed(dismissal.current);
        setDismissed(dismissal.current);
      },
    });
  }, [api, view?.kind, view?.version, view?.progress, view?.dismissal, busy]);

  useEffect(() => () => { dismissNotification(DESKTOP_UPDATE_NOTIFICATION_ID); }, []);
  return null;
}
