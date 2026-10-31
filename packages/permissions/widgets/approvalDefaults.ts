import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sessionFetch } from "@polyth/session/web-api";
import { confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { settingsErrorText, type SaveStatusState } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

/** Off asks for everything, routine is Auto-Approve, all is Full access. */
export type ApprovalLevel = "off" | "routine" | "all";

export interface ApprovalDefault {
  level: ApprovalLevel;
  changedAt?: number;
  changedBy?: string;
}

/** The Space's approval defaults: the level a chat gets when neither it nor a
 *  chat above it picked one — its project's own level, else the Space's. */
export interface ApprovalDefaultsState extends ApprovalDefault {
  projects: Record<string, ApprovalDefault>;
  /** Only the instance owner changes them. */
  canEdit: boolean;
}

export const APPROVAL_DEFAULTS_PATH = "/api/permissions/defaults";

const isLevel = (value: unknown): value is ApprovalLevel =>
  value === "off" || value === "routine" || value === "all";

/** Anything unreadable reads as off, like the server. */
const normalize = (raw: unknown): ApprovalDefaultsState => {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const entry = (item: unknown): ApprovalDefault => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      level: isLevel(record.level) ? record.level : "off",
      ...(typeof record.changedAt === "number" ? { changedAt: record.changedAt } : {}),
      ...(typeof record.changedBy === "string" ? { changedBy: record.changedBy } : {}),
    };
  };
  const projects = value.projects && typeof value.projects === "object" && !Array.isArray(value.projects)
    ? Object.fromEntries(Object.entries(value.projects as Record<string, unknown>).map(([id, item]) => [id, entry(item)]))
    : {};
  return { ...entry(value), projects, canEdit: value.canEdit === true };
};

/** The level a chat in `projectId` starts with when nothing above it chose. */
export const defaultApprovalLevel = (state: ApprovalDefaultsState | undefined, projectId?: string | null): ApprovalLevel =>
  (projectId ? state?.projects[projectId]?.level : undefined) ?? state?.level ?? "off";

/** Full access as a default takes two separate warnings: what it does, then
 *  that it applies to every chat it covers without asking again. */
export async function confirmFullAccessDefault(project?: string): Promise<boolean> {
  if (!(await confirmAlert(
    project
      ? tr("permissionbanner.projectFullAccessWarning1", { project })
      : tr("permissionbanner.fullAccessAlwaysWarning1"),
    {
      title: project
        ? tr("permissionbanner.projectFullAccessWarning1Title", { project })
        : tr("permissionbanner.fullAccessAlwaysWarning1Title"),
      confirmLabel: tr("permissionbanner.fullAccessAlwaysWarning1Label"),
      destructive: true,
    },
  ))) return false;
  return confirmAlert(
    project
      ? tr("permissionbanner.projectFullAccessWarning2", { project })
      : tr("permissionbanner.fullAccessAlwaysWarning2"),
    {
      title: project
        ? tr("permissionbanner.projectFullAccessWarning2Title", { project })
        : tr("permissionbanner.fullAccessAlwaysWarning2Title"),
      confirmLabel: project
        ? tr("permissionbanner.projectFullAccessWarning2Label")
        : tr("permissionbanner.fullAccessAlwaysWarning2Label"),
      destructive: true,
    },
  );
}

// Undefined until the first read finishes; reads as off meanwhile.
let current: ApprovalDefaultsState | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const publish = (next: ApprovalDefaultsState) => {
  current = next;
  for (const listener of listeners) listener();
};

export function loadApprovalDefaults(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = sessionFetch<unknown>(APPROVAL_DEFAULTS_PATH)
    .then((state) => publish(normalize(state)))
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

const put = async (path: string, level: ApprovalLevel | "inherit"): Promise<ApprovalDefaultsState> => {
  const next = normalize(await sessionFetch<unknown>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level }),
  }));
  publish(next);
  return next;
};

export const saveSpaceApprovalLevel = (level: ApprovalLevel): Promise<ApprovalDefaultsState> =>
  put(APPROVAL_DEFAULTS_PATH, level);

/** "inherit" gives the project back to the Space's level. */
export const saveProjectApprovalLevel = (projectId: string, level: ApprovalLevel | "inherit"): Promise<ApprovalDefaultsState> =>
  put(`${APPROVAL_DEFAULTS_PATH}/projects/${encodeURIComponent(projectId)}`, level);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The defaults, or undefined while they have not loaded. Pass
 *  `active: false` where they are not needed to skip the request. */
export function useApprovalDefaults(active = true): ApprovalDefaultsState | undefined {
  useEffect(() => {
    if (active) void loadApprovalDefaults().catch(() => {});
  }, [active]);
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Opened editors re-read the defaults (another device may have changed
 *  them) and report a failed read for "Try again". */
export function useFreshApprovalDefaults(): { state: ApprovalDefaultsState | undefined; loadError: unknown; reload(): void } {
  const state = useApprovalDefaults(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const reload = () => {
    setLoadError(null);
    void loadApprovalDefaults(true).catch((error: unknown) => setLoadError(error));
  };
  useEffect(reload, []);
  return { state, loadError, reload };
}

/** One autosave at a time, reported through `SaveStatus`. */
export function useApprovalSave(): {
  status: SaveStatusState;
  error: string | undefined;
  busy: boolean;
  save(work: () => Promise<unknown>): Promise<void>;
} {
  const [status, setStatus] = useState<SaveStatusState>("idle");
  const [error, setError] = useState<string | undefined>();
  const running = useRef(false);
  const save = async (work: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setStatus("saving");
    setError(undefined);
    try {
      await work();
      setStatus("saved");
    } catch (reason) {
      setStatus("error");
      setError(settingsErrorText(reason).message);
    } finally {
      running.current = false;
    }
  };
  return { status, error, busy: status === "saving", save };
}
