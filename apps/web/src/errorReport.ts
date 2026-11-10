// "Copy error": the short notice stays written for people; this report holds
// what a person pastes into a bug report or a chat with an agent — the error's
// own words, its typed diagnostics and the server's request id, so the failure
// can be found in the server's records afterwards. It carries no device, path
// or account details beyond what the error itself says.

import { setUiError, type UiErrorAction } from "./store.ts";
import { tr } from "./i18n/index.ts";
import { copyText } from "./utils.ts";

declare const __POLYTH_WEB_BUILD_ID__: string;

export interface ErrorReportContext {
  /** What the person was doing, in plain words ("Start a new chat"). */
  action: string;
  /** The notice they saw, so the report matches the screen. */
  shown: string;
  now?: Date;
}

const MAX_FIELD = 600;

const clip = (value: string): string =>
  value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value;

/** Typed fields an error may carry: the server's diagnostics (sessionFetch
 *  copies them onto the Error) and the harness reason in `details`. */
const REPORT_FIELDS = [
  ["status", "HTTP status"],
  ["code", "Code"],
  ["mutationOutcome", "Outcome"],
  ["component", "Component"],
  ["operation", "Operation"],
  ["requestId", "Request id"],
  ["details", "Details"],
] as const;

export function errorReportText(error: unknown, context: ErrorReportContext): string {
  const lines = [
    "Polyth error report",
    `Time: ${(context.now ?? new Date()).toISOString()}`,
    `Action: ${context.action}`,
    `Shown: ${clip(context.shown)}`,
  ];
  if (typeof __POLYTH_WEB_BUILD_ID__ === "string" && __POLYTH_WEB_BUILD_ID__) {
    lines.push(`Web build: ${__POLYTH_WEB_BUILD_ID__}`);
  }
  if (error instanceof Error) {
    lines.push(`Error: ${clip(`${error.name}: ${error.message}`)}`);
  } else if (error !== undefined && error !== null) {
    lines.push(`Error: ${clip(String(error))}`);
  }
  if (error && typeof error === "object") {
    const typed = error as Record<string, unknown>;
    for (const [key, label] of REPORT_FIELDS) {
      const value = typed[key];
      if (typeof value === "string" && value !== "") lines.push(`${label}: ${clip(value)}`);
      else if (typeof value === "number" && Number.isFinite(value)) lines.push(`${label}: ${value}`);
    }
    // A transport failure's cause is often the only concrete fact.
    const cause = typed.cause;
    if (cause instanceof Error && cause.message) lines.push(`Cause: ${clip(`${cause.name}: ${cause.message}`)}`);
  }
  return lines.join("\n");
}

/** The notice's one action: copy the report, then say whether it worked. */
export function copyErrorAction(report: string): UiErrorAction {
  return {
    label: tr("app.copyError"),
    run: async () => {
      const copied = await copyText(report);
      setUiError(tr(copied ? "app.errorCopied" : "app.errorCopyFailed"), null, undefined, copied ? "info" : "warning");
    },
  };
}
