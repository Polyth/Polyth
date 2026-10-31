import type { DesktopUpdateState } from "./types.ts";

/** What a button of the small update window asks main to do. */
export type UpdateWindowAction = "download" | "install" | "hide" | "retry";

export const UPDATE_WINDOW_ACTIONS: readonly UpdateWindowAction[] = ["download", "install", "hide", "retry"];

export interface UpdateWindowButton {
  action: UpdateWindowAction;
  label: string;
  primary?: boolean;
}

export interface UpdateWindowView {
  title: string;
  detail: string;
  /** 0..1 fills the bar, null runs it indeterminate, undefined hides it. */
  progress?: number | null;
  /** Text beside the bar ("42%"). */
  progressLabel?: string;
  buttons: UpdateWindowButton[];
  /** The corner close button; absent while Polyth is handing over to the installer. */
  closable: boolean;
}

export const UPDATE_WINDOW_SIZE = { width: 380, height: 156 } as const;

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

const downloadDetail = (state: DesktopUpdateState): string => {
  if (!finite(state.transferred) || !finite(state.total) || state.total <= 0) return "Starting the download…";
  const amount = `${formatBytes(state.transferred)} of ${formatBytes(state.total)}`;
  return finite(state.bytesPerSecond) && state.bytesPerSecond > 0
    ? `${amount} · ${formatBytes(state.bytesPerSecond)}/s`
    : amount;
};

const hide = (label: string, primary = false): UpdateWindowButton => ({ action: "hide", label, ...(primary ? { primary } : {}) });

/** The small update window's content for one updater state. */
export function updateWindowView(state: DesktopUpdateState): UpdateWindowView {
  const name = state.version ? `Polyth ${state.version}` : "The update";
  switch (state.phase) {
    case "available":
      return {
        title: `${name} is available`,
        detail: "Download it now. It installs when Polyth restarts.",
        buttons: [hide("Later"), { action: "download", label: "Download", primary: true }],
        closable: true,
      };
    case "downloading": {
      const percent = finite(state.percent) ? Math.min(100, Math.max(0, state.percent)) : null;
      return {
        title: `Downloading ${name}`,
        detail: downloadDetail(state),
        progress: percent === null ? null : percent / 100,
        ...(percent === null ? {} : { progressLabel: `${Math.floor(percent)}%` }),
        buttons: [hide("Hide")],
        closable: true,
      };
    }
    case "downloaded":
      return {
        title: `${name} is ready to install`,
        detail: "Restart Polyth to install it now, or it installs the next time you quit.",
        progress: 1,
        progressLabel: "100%",
        buttons: [hide("Later"), { action: "install", label: "Restart now", primary: true }],
        closable: true,
      };
    case "installing":
      return {
        title: `Installing ${name}…`,
        detail: "Polyth closes, installs the update and opens again by itself.",
        progress: null,
        buttons: [],
        closable: false,
      };
    case "installed":
      return {
        title: `${name} is installed`,
        detail: "You are on the newest version.",
        buttons: [hide("OK", true)],
        closable: true,
      };
    case "checking":
      return { title: "Checking for updates…", detail: state.message, progress: null, buttons: [hide("Hide")], closable: true };
    case "error":
      return {
        title: "The update did not finish",
        detail: state.message,
        buttons: [hide("Close"), { action: "retry", label: "Try again", primary: true }],
        closable: true,
      };
    case "up-to-date":
      return { title: "Polyth is up to date", detail: state.message, buttons: [hide("OK", true)], closable: true };
    default:
      return { title: "Polyth updates", detail: state.message, buttons: [hide("Close", true)], closable: true };
  }
}

interface Area { x: number; y: number; width: number; height: number }

/** Bottom-right corner of the work area, clear of the taskbar. */
export const updateWindowBounds = (
  workArea: Area,
  size: { width: number; height: number } = UPDATE_WINDOW_SIZE,
  margin = 16,
): Area => {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    x: Math.round(workArea.x + Math.max(0, workArea.width - width - margin)),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height - margin)),
    width,
    height,
  };
};

/** A pending install written right before the handover, read on the next start. */
export interface PendingUpdate {
  version: string;
  from: string;
}

export const parsePendingUpdate = (raw: string): PendingUpdate | null => {
  try {
    const value = JSON.parse(raw) as Partial<PendingUpdate> | null;
    if (!value || typeof value.version !== "string" || typeof value.from !== "string") return null;
    if (!value.version.trim() || !value.from.trim()) return null;
    return { version: value.version, from: value.from };
  } catch {
    return null;
  }
};

/** What the next start learns from a pending install: done, failed, or nothing to say. */
export const pendingUpdateOutcome = (
  pending: PendingUpdate | null,
  runningVersion: string,
): DesktopUpdateState | null => {
  if (!pending) return null;
  if (pending.version === runningVersion) {
    return { phase: "installed", message: `Polyth ${runningVersion} is installed.`, version: runningVersion };
  }
  if (pending.from === runningVersion) {
    return {
      phase: "error",
      message: `Polyth ${pending.version} did not install. This copy is still ${runningVersion}.`,
      version: pending.version,
    };
  }
  return null;
};
