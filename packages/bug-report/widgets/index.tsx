// Nightly bug reports: one `bug-report` capability (the palette command
// `capability.bug-report`, which the `reportBug` hotkey ⌘⇧B / Ctrl+Shift+B and
// the desktop Help menu run) and one dialog layer. It is available where the
// desktop shell says reports are on (nightly builds of the standard edition)
// or, in a browser, where this page's Polyth server does (a nightly server).
import "./styles.css";
import { createElement, useSyncExternalStore } from "react";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { BUG_REPORT_CAPABILITY_ID } from "../src/index.ts";
import { enabledPackages, recentErrors, uiSettings, viewName, viewport, webFacts } from "../src/snapshot.ts";
import { reportBridge, type ReportBridge, type ReportCapture } from "./bridge.ts";
import { serverReportBridge } from "./serverBridge.ts";
import { ReportSheet, type PageReport } from "./ReportSheet.tsx";

declare const __POLYTH_WEB_BUILD_ID__: string;

interface OpenSheet {
  bridge: ReportBridge;
  capture: ReportCapture;
  page: PageReport;
}

let sheet: OpenSheet | null = null;
let opening = false;
const listeners = new Set<() => void>();
const setSheet = (next: OpenSheet | null) => {
  sheet = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const api = createApiTransport({ readRetry: false });

async function serverFacts(): Promise<{ version: unknown; packages: unknown }> {
  const timeout = <T,>(promise: Promise<T>) =>
    Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))]);
  const [health, packages] = await Promise.all([
    timeout(api.request<{ version?: unknown }>("/api/health")).catch(() => null),
    timeout(api.request<unknown>("/api/packages")).catch(() => null),
  ]);
  return { version: health?.version, packages };
}

async function pageReport(host: WebPackageHost): Promise<PageReport> {
  const snapshot = host.store.getSnapshot();
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const media = (query: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const server = await serverFacts();
  return {
    web: webFacts({
      build: typeof __POLYTH_WEB_BUILD_ID__ === "string" ? __POLYTH_WEB_BUILD_ID__ : "",
      serverVersion: server.version,
      view: viewName(snapshot),
      viewport: viewport(window.innerWidth, window.innerHeight, window.devicePixelRatio),
    }),
    settings: uiSettings(snapshot.settings, {
      rootFlags: root ? { ...root.dataset } : {},
      prefersReducedMotion: media("(prefers-reduced-motion: reduce)"),
      prefersDark: media("(prefers-color-scheme: dark)"),
      language: typeof navigator === "undefined" ? "" : navigator.language,
    }),
    packages: enabledPackages(server.packages),
    errors: recentErrors(host.errors.recent?.() ?? []),
  };
}

async function openReport(host: WebPackageHost, bridge: ReportBridge): Promise<void> {
  if (sheet || opening) return;
  opening = true;
  try {
    // The screenshot first, while the window still shows what went wrong.
    const capture = await bridge.capture();
    setSheet({ bridge, capture, page: await pageReport(host) });
  } catch {
    host.errors.show?.(host.ui.locale.translate("bugreport.openFailed"));
  } finally {
    opening = false;
  }
}

function ReportLayer({ host }: { host: WebPackageHost }) {
  const open = useSyncExternalStore(subscribe, () => sheet, () => null);
  if (!open) return null;
  return createElement(ReportSheet, {
    key: open.capture.captureId,
    host,
    bridge: open.bridge,
    capture: open.capture,
    page: open.page,
    onClose: () => setSheet(null),
  });
}

/** The desktop shell when it reports; otherwise this page's server. A stable
 *  desktop window showing a nightly server reports through the server. */
async function chooseBridge(): Promise<ReportBridge | null> {
  const desktop = reportBridge();
  if (desktop) {
    const state = await desktop.state().catch(() => null);
    if (state?.available) return desktop;
  }
  const server = serverReportBridge(api);
  const state = await server.state().catch(() => null);
  return state?.available ? server : null;
}

export default defineWebPackage((host) => () => {
  // Settled once at start: until then the command is not offered.
  let bridge: ReportBridge | null = null;
  let disposed = false;
  const off = [
    host.slots.register({
      slot: "app.layers",
      id: "bug-report.sheet",
      render: () => createElement(ReportLayer, { host }),
    }),
    host.capabilities.register({
      id: BUG_REPORT_CAPABILITY_ID,
      label: host.ui.locale.translate("bugreport.title"),
      technicalLabel: "Bug report",
      plainDescription: host.ui.locale.translate("bugreport.description"),
      keywords: ["bug", "report", "feedback", "nightly", "screenshot", "issue", "problem"],
      standardTier: "technical",
      standardRank: 90,
      rail: false,
      launcherWidget: false,
      kind: "command",
      open: () => { if (bridge) void openReport(host, bridge); },
      available: () => bridge !== null,
    }),
  ];
  void chooseBridge().then((chosen) => {
    if (disposed || !chosen) return;
    bridge = chosen;
    host.capabilities.notify();
  }, () => {});
  return () => {
    disposed = true;
    setSheet(null);
    off.toReversed().forEach((dispose) => dispose());
  };
});
