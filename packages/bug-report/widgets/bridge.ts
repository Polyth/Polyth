// The desktop shell's report API (`window.polythDesktop.bugReport`, defined
// in apps/desktop/src/types.ts). A local structural type: the package never
// imports the host's bridge module, and an older shell simply lacks it.
import type {
  BugReportApp,
  BugReportError,
  BugReportPackage,
  BugReportSettingValue,
  BugReportWeb,
} from "@polyth/contracts/bug-report";

export interface ReportState {
  available: boolean;
  needsPassword: boolean;
  queued: number;
}

export interface ReportCapture {
  captureId: string;
  screenshot: { dataUrl: string; width: number; height: number; bytes: number } | null;
  base: { app: BugReportApp; install: string; settings: Record<string, BugReportSettingValue> };
  needsPassword: boolean;
  /** Absent from older shells: the generic hint is shown then. */
  passwordStorage?: "keychain" | "session";
}

export interface ReportDraft {
  captureId: string | null;
  text: string;
  contact: string;
  web: BugReportWeb;
  settings: Record<string, BugReportSettingValue>;
  packages: BugReportPackage[];
  errors: BugReportError[];
  password?: string;
}

export type ReportOutcome =
  | { result: "created" | "added"; issue: number }
  | { result: "queued" | "password" | "rate" | "version" | "invalid" | "unavailable" };

export interface ReportBridge {
  state(): Promise<ReportState>;
  capture(): Promise<ReportCapture>;
  send(draft: ReportDraft): Promise<ReportOutcome>;
}

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

/** The desktop report API, or null outside the desktop app or on a shell
 *  older than bug reports. */
export function reportBridge(scope: unknown = typeof window === "undefined" ? undefined : window): ReportBridge | null {
  const desktop = (scope as { polythDesktop?: { bugReport?: unknown } } | undefined)?.polythDesktop;
  const api = desktop?.bugReport as Partial<ReportBridge> | undefined;
  return api && isFunction(api.state) && isFunction(api.capture) && isFunction(api.send) ? api as ReportBridge : null;
}
