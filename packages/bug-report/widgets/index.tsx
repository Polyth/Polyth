// Feedback: one `bug-report` capability (the palette command
// `capability.bug-report`, which the `reportBug` hotkey ⌘⇧B / Ctrl+Shift+B and
// the desktop Help menu run) and one dialog layer. It is available on every
// channel where the desktop shell or, in a browser, this page's Polyth server
// says feedback is on; nothing is sent until the person presses Send.
import "./styles.css";
import { createElement, useSyncExternalStore } from "react";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { BUG_REPORT_CAPABILITY_ID } from "../src/index.ts";
import { viewportBlurs, type Mark, type Rect } from "../src/annotate.ts";
import { enabledPackages, recentErrors, uiSettings, viewName, viewport, webFacts } from "../src/snapshot.ts";
import { reportBridge, type ReportBridge, type ReportCapture } from "./bridge.ts";
import { serverReportBridge } from "./serverBridge.ts";
import { ReportSheet, type PageReport } from "./ReportSheet.tsx";

declare const __POLYTH_WEB_BUILD_ID__: string;

interface OpenSheet {
  bridge: ReportBridge;
  capture: ReportCapture;
  page: PageReport;
  privateAreas: Mark[];
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

/** Where the host's private content (`data-private`: the conversation, the
 *  draft, chat and project names) is visible, in viewport CSS pixels: each
 *  element grown by a little for overhanging glyphs, then cut to the viewport
 *  and to every ancestor that clips it. Blurring a bit too much is fine;
 *  missing a visible piece is not. */
function privateAreas(): Rect[] {
  if (typeof document === "undefined") return [];
  const clips = new Map<Element, DOMRect | null>();
  const clipOf = (node: Element) => {
    let clip = clips.get(node);
    if (clip === undefined) {
      const style = getComputedStyle(node);
      clip = style.overflowX !== "visible" || style.overflowY !== "visible" ? node.getBoundingClientRect() : null;
      clips.set(node, clip);
    }
    return clip;
  };
  const areas: Rect[] = [];
  for (const element of document.querySelectorAll("[data-private]")) {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    let left = Math.max(0, box.left - 2);
    let top = Math.max(0, box.top - 2);
    let right = Math.min(window.innerWidth, box.right + 2);
    let bottom = Math.min(window.innerHeight, box.bottom + 2);
    for (let node = element.parentElement; node && node !== document.body && right > left && bottom > top; node = node.parentElement) {
      const clip = clipOf(node);
      if (!clip) continue;
      left = Math.max(left, clip.left);
      top = Math.max(top, clip.top);
      right = Math.min(right, clip.right);
      bottom = Math.min(bottom, clip.bottom);
    }
    if (right > left && bottom > top) areas.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return areas;
}

async function openReport(host: WebPackageHost, bridge: ReportBridge): Promise<void> {
  if (sheet || opening) return;
  opening = true;
  try {
    // The screenshot first, while the window still shows what went wrong;
    // where private content sits is read in the same moment.
    const areas = privateAreas();
    const view = { width: window.innerWidth, height: window.innerHeight };
    const capture = await bridge.capture();
    const privateMarks = capture.screenshot ? viewportBlurs(areas, view, capture.screenshot) ?? [] : [];
    setSheet({ bridge, capture, page: await pageReport(host), privateAreas: privateMarks });
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
    privateAreas: open.privateAreas,
    onClose: () => setSheet(null),
  });
}

/** The desktop shell when it sends feedback; otherwise this page's server. */
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
      technicalLabel: "Feedback",
      plainDescription: host.ui.locale.translate("bugreport.description"),
      keywords: ["feedback", "bug", "report", "idea", "suggestion", "screenshot", "issue", "problem"],
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
