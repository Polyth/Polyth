// What the buttons do. Every outcome is said once, on the shell's notification
// stack; nothing here decides what a page may do.
import type { MarkdownFenceActionInput, WebPackageHost } from "@polyth/web-sdk";
import { confirmAlert, promptAlert } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { APP_LIMITS, type AppView } from "../src/apps.ts";
import { removeApp, renameApp, saveApp } from "./client.ts";
import { PAGE_APPS_SURFACE_ID } from "./ids.ts";

export function reportFailure(host: WebPackageHost, title: string, cause: unknown): void {
  host.notifications?.show({
    kind: "error",
    title,
    ...(cause instanceof Error && cause.message ? { body: cause.message } : {}),
  });
}

export const showApp = (host: WebPackageHost, id: string): boolean =>
  host.navigation.openWorkspacePane(PAGE_APPS_SURFACE_ID, id);

/** The app in a window of its own; the browser may refuse a pop-up. */
export function showAppWindow(host: WebPackageHost, id: string): void {
  const opened = host.navigation.openPaneWindow?.(PAGE_APPS_SURFACE_ID, id);
  if (opened === undefined) { showApp(host, id); return; }
  if (!opened) host.notifications?.show({ id: "pageapps.window", kind: "warning", title: tr("pageapps.window.blocked") });
}

/** "Save as app" on a page: keep it, or bring the app it already is up to date. */
export async function savePageAsApp(host: WebPackageHost, input: MarkdownFenceActionInput): Promise<void> {
  const { projectId, sessionId } = input.context;
  try {
    const { app, outcome } = await saveApp({
      title: input.title.slice(0, APP_LIMITS.titleChars),
      html: input.content,
      source: {
        ...(sessionId ? { sessionId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(input.from ? { from: input.from } : {}),
      },
    });
    host.notifications?.show({
      id: "pageapps.saved",
      kind: outcome === "unchanged" ? "info" : "success",
      title: tr(`pageapps.saved.${outcome}`, { title: app.title, version: app.version }),
      actions: [{ label: tr("pageapps.saved.open"), primary: true, run: () => { showApp(host, app.id); } }],
    });
  } catch (cause) {
    reportFailure(host, tr("pageapps.save.failed"), cause);
  }
}

export async function renameWithPrompt(host: WebPackageHost, app: AppView): Promise<void> {
  const title = await promptAlert(tr("pageapps.rename.message"), {
    title: tr("pageapps.rename.title"),
    confirmLabel: tr("pageapps.rename"),
    initialValue: app.title,
  });
  const next = title?.trim();
  if (!next || next === app.title) return;
  try {
    await renameApp(app.id, next);
  } catch (cause) {
    reportFailure(host, tr("pageapps.failed"), cause);
  }
}

/** True when the app was removed. */
export async function removeWithConfirm(host: WebPackageHost, app: AppView): Promise<boolean> {
  const sure = await confirmAlert(tr("pageapps.remove.message"), {
    title: tr("pageapps.remove.title", { title: app.title }),
    confirmLabel: tr("pageapps.remove"),
    destructive: true,
  });
  if (!sure) return false;
  try {
    await removeApp(app.id);
    host.notifications?.show({ id: "pageapps.removed", kind: "info", title: tr("pageapps.removed") });
    return true;
  } catch (cause) {
    reportFailure(host, tr("pageapps.failed"), cause);
    return false;
  }
}
