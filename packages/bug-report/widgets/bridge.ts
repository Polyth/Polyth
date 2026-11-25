// Where feedback goes: the desktop shell's report API
// (`window.polythDesktop.bugReport`, defined in apps/desktop/src/types.ts) or,
// for a page opened in a browser, this package's server routes
// (serverBridge.ts). A local structural type: the package never imports the
// host's bridge module, and an older shell simply lacks it.
import type {
  BugReportApp,
  BugReportError,
  BugReportPackage,
  BugReportSettingValue,
  BugReportWeb,
} from "@polyth/contracts/bug-report";
import type { FeedbackKind, FeedbackProfile } from "@polyth/contracts/feedback";

export interface ReportState {
  available: boolean;
  queued: number;
}

export interface ReportCapture {
  captureId: string;
  screenshot: { dataUrl: string; width: number; height: number; bytes: number } | null;
  /** What the shell or server adds to every feedback, shown before sending. */
  base: {
    app: BugReportApp;
    settings: Record<string, BugReportSettingValue>;
    /** The pseudonym that changes every day (anonymous feedback). */
    installDaily: string;
    /** The pseudonym the person can reset: sent only with a profile or contact. */
    installPerson: string;
    /** The profile the person saved with an earlier feedback, to prefill. */
    savedProfile: FeedbackProfile | null;
  };
}

/** The sheet's part of a feedback. A part the person left out is null: it is
 *  sent exactly when it is present, so the preview and the wire agree. */
export interface ReportDraft {
  kind: FeedbackKind;
  text: string;
  /** "" for none. */
  contact: string;
  captureId: string | null;
  technical: {
    web: BugReportWeb;
    settings: Record<string, BugReportSettingValue>;
    packages: BugReportPackage[];
    errors: BugReportError[];
  } | null;
  profile: FeedbackProfile | null;
}

export type ReportOutcome =
  | { result: "received"; ref: number }
  | { result: "queued" | "rate" | "invalid" | "unavailable" };

export type ForgetOutcome = { result: "forgotten"; count: number } | { result: "unavailable" };

export interface ReportBridge {
  state(): Promise<ReportState>;
  capture(): Promise<ReportCapture>;
  send(draft: ReportDraft): Promise<ReportOutcome>;
  /** A pasted or attached image becomes the capture's screenshot (encoded as
   *  it will be sent), or null when it cannot be read. Absent on the desktop
   *  shell, which always captures the window itself. */
  attach?(captureId: string, file: Blob): Promise<ReportCapture["screenshot"]>;
  /** The screenshot with the person's marks drawn in (a JPEG) replaces the
   *  capture's screenshot, re-encoded to the wire's limits; null when it
   *  cannot be read. Absent from desktop shells older than marking up: the
   *  sheet then offers no editor rather than send an unmarked image. */
  annotate?(captureId: string, jpeg: Uint8Array): Promise<ReportCapture["screenshot"]>;
  /** Erases what was sent under the resettable pseudonym and starts a new
   *  one. Absent from shells older than feedback. */
  forget?(): Promise<ForgetOutcome>;
}

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

/** The desktop report API, or null outside the desktop app or on a shell
 *  older than feedback. */
export function reportBridge(scope: unknown = typeof window === "undefined" ? undefined : window): ReportBridge | null {
  const desktop = (scope as { polythDesktop?: { bugReport?: unknown } } | undefined)?.polythDesktop;
  const api = desktop?.bugReport as Partial<ReportBridge> | undefined;
  return api && isFunction(api.state) && isFunction(api.capture) && isFunction(api.send) ? api as ReportBridge : null;
}
