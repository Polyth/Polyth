// Background harness installs, as this browser follows them.
//
// The server owns the install; this store reads it, polls while it is under
// way (once a second, only then) and keeps following after Settings closes, so
// a person who hides the dialog still hears how it ended: a progress
// notification while it runs, then the outcome with a way back to it.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { HarnessInstallDto, HarnessInstallPreviewDto } from "@polyth/contracts";
import { ApiError, createApiTransport, type WebNotificationHandle, type WebPackageHost } from "@polyth/web-sdk";
import { invalidateRuntimeCatalogs } from "@polyth/models/runtime-catalog";
import { englishTranslate } from "./englishTranslate.ts";
import { installIsActive } from "./installPresentation.ts";

const api = createApiTransport();
export const INSTALL_POLL_MS = 1_000;
/** Unanswered reads back off to this; an install is never silently dropped. */
const MAX_POLL_MS = 15_000;

type Snapshot = {
    /** project key → harness id → the install for where that project sets it up. */
    projects: ReadonlyMap<string, ReadonlyMap<string, HarnessInstallDto>>;
    /** Harness ids whose install dialog is on screen. */
    visible: ReadonlySet<string>;
    /** A notification asked Settings to show this harness's install. */
    requested?: { harnessId: string; seq: number };
};

let snapshot: Snapshot = { projects: new Map(), visible: new Set() };
const listeners = new Set<() => void>();
const settledListeners = new Set<(job: HarnessInstallDto) => void>();
const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
const projectKey = (projectId?: string | null) => projectId ?? "";
const empty: ReadonlyMap<string, HarnessInstallDto> = new Map();
const query = (projectId?: string | null) => projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
const installPath = (harnessId: string) => `/api/harnesses/${encodeURIComponent(harnessId)}/install`;

/** The host whose notifications and navigation report an install that ends
 *  while its dialog is closed. Settings binds it while it is mounted; the
 *  last one stays for an install that outlives the page. */
let boundHost: WebPackageHost | undefined;
const notices = new Map<string, WebNotificationHandle>();
/** Installs someone sent to the background (closed the dialog mid-way): only
 *  these get a progress notification; the page row already shows the rest. */
const backgrounded = new Set<string>();
/** Installs whose end was already reported (one local install can be
 *  followed from several projects). */
const settled = new Set<string>();
const noticeId = (harnessId: string) => `harness-install:${harnessId}`;

/** An install the server no longer knows (it restarted, or the package was
 *  turned off) ended without telling us how. */
const lost = (job: HarnessInstallDto): HarnessInstallDto => ({
    ...job,
    phase: "failed",
    finishedAt: Date.now(),
    failure: { kind: "interrupted", message: boundHost ? boundHost.ui.locale.translate("harnessruntime.installs.interrupted") : englishTranslate("installs.interrupted") },
});

function store(projectId: string | null | undefined, job: HarnessInstallDto | null | undefined, harnessId: string): void {
    const key = projectKey(projectId);
    const current = snapshot.projects.get(key) ?? empty;
    const previous = current.get(harnessId);
    const next = job ?? (previous && installIsActive(previous) ? lost(previous) : undefined);
    const jobs = new Map(current);
    if (next) jobs.set(harnessId, next);
    else jobs.delete(harnessId);
    publish({ ...snapshot, projects: new Map(snapshot.projects).set(key, jobs) });
    if (next) follow(projectId, next, previous);
}

const polls = new Map<string, ReturnType<typeof setTimeout>>();
const misses = new Map<string, number>();
function follow(projectId: string | null | undefined, job: HarnessInstallDto, previous: HarnessInstallDto | undefined): void {
    const pollKey = `${projectKey(projectId)}|${job.harnessId}`;
    if (installIsActive(job)) {
        notifyProgress(job);
        if (!polls.has(pollKey)) {
            const delay = Math.min(MAX_POLL_MS, INSTALL_POLL_MS * 2 ** (misses.get(pollKey) ?? 0));
            polls.set(pollKey, setTimeout(() => {
                polls.delete(pollKey);
                void readHarnessInstall(job.harnessId, projectId).then(() => { misses.delete(pollKey); }, (cause: unknown) => {
                    const current = snapshot.projects.get(projectKey(projectId))?.get(job.harnessId);
                    if (!installIsActive(current)) return;
                    // No such route or harness any more: it will not answer.
                    if (cause instanceof ApiError && cause.status === 404) {
                        store(projectId, null, job.harnessId);
                        return;
                    }
                    // Unreachable for now: ask again, less often.
                    misses.set(pollKey, (misses.get(pollKey) ?? 0) + 1);
                    follow(projectId, current!, current);
                });
            }, delay));
        }
        return;
    }
    misses.delete(pollKey);
    // Ended since we last looked: everything cached about the harness is old.
    if (previous && installIsActive(previous) && previous.id === job.id && !settled.has(job.id)) {
        settled.add(job.id);
        invalidateRuntimeCatalogs();
        notifyOutcome(job);
        for (const listener of [...settledListeners]) listener(job);
    }
}

const translate = (key: string, values?: Record<string, string | number>) =>
    boundHost?.ui.locale.translate(`harnessruntime.install.${key}`, values) ?? key;

const openInSettings = (harnessId: string) => {
    publish({ ...snapshot, requested: { harnessId, seq: (snapshot.requested?.seq ?? 0) + 1 } });
    boundHost?.navigation.openSettingsPage("harnesses");
};

function notifyProgress(job: HarnessInstallDto): void {
    const notifications = boundHost?.notifications;
    if (!notifications || snapshot.visible.has(job.harnessId) || !backgrounded.has(job.harnessId)) return;
    const body = job.activity ?? (job.phase === "queued" ? translate("step.waiting") : undefined);
    const existing = notices.get(job.harnessId);
    if (existing) {
        existing.update({ title: translate("notify.running", { name: job.harnessName }), ...(body ? { body } : {}) });
        return;
    }
    notices.set(job.harnessId, notifications.show({
        id: noticeId(job.harnessId),
        kind: "progress",
        progress: null,
        duration: "sticky",
        title: translate("notify.running", { name: job.harnessName }),
        ...(body ? { body } : {}),
        data: { "harness-install": job.harnessId },
        actions: [{ label: translate("action.show"), run: () => openInSettings(job.harnessId) }],
        onDismiss: () => { notices.delete(job.harnessId); },
    }));
}

function notifyOutcome(job: HarnessInstallDto): void {
    const notice = notices.get(job.harnessId);
    notices.delete(job.harnessId);
    backgrounded.delete(job.harnessId);
    if (snapshot.visible.has(job.harnessId) || job.phase === "cancelled") {
        notice?.dismiss();
        return;
    }
    const notifications = boundHost?.notifications;
    if (!notifications) return;
    const succeeded = job.phase === "succeeded";
    const input = {
        kind: succeeded ? "success" as const : "error" as const,
        title: translate(succeeded ? "notify.succeeded" : "notify.failed", { name: job.harnessName }),
        progress: undefined,
        duration: succeeded ? 12_000 : "sticky" as const,
        ...(succeeded && job.result?.state !== "ready" ? { body: translate("notify.succeededBody") } : {}),
        ...(!succeeded && job.failure ? { body: job.failure.message } : {}),
        actions: [{ label: translate("action.open"), primary: true, run: () => openInSettings(job.harnessId) }],
    };
    if (notice) notice.update(input);
    else notifications.show({ id: noticeId(job.harnessId), ...input, data: { "harness-install": job.harnessId } });
}

/** Installs this project would follow, one per harness. A server without the
 *  route reports none. */
export async function loadHarnessInstalls(projectId?: string | null): Promise<void> {
    const rows = await api.get<HarnessInstallDto[]>(`/api/harnesses/installs${query(projectId)}`).catch(() => [] as HarnessInstallDto[]);
    const key = projectKey(projectId);
    const previous = snapshot.projects.get(key) ?? empty;
    publish({ ...snapshot, projects: new Map(snapshot.projects).set(key, new Map(rows.map((job) => [job.harnessId, job]))) });
    for (const job of rows) follow(projectId, job, previous.get(job.harnessId));
}

/** What an install would run and where, and the install on record. */
export async function readHarnessInstall(harnessId: string, projectId?: string | null): Promise<{ preview: HarnessInstallPreviewDto; job: HarnessInstallDto | null }> {
    const result = await api.get<{ preview: HarnessInstallPreviewDto; job: HarnessInstallDto | null }>(`${installPath(harnessId)}${query(projectId)}`);
    store(projectId, result.job, harnessId);
    return result;
}

export async function startHarnessInstall(harnessId: string, projectId?: string | null): Promise<HarnessInstallDto> {
    const job = await api.post<HarnessInstallDto>(installPath(harnessId), projectId ? { projectId } : {});
    store(projectId, job, harnessId);
    return job;
}

export async function cancelHarnessInstall(harnessId: string, projectId?: string | null): Promise<void> {
    const job = await api.delete<HarnessInstallDto | null>(`${installPath(harnessId)}${query(projectId)}`);
    store(projectId, job, harnessId);
}

/** The dialog is (not) on screen: no progress notification while it is, and
 *  one appears when it is hidden mid-install. */
export function setInstallDialogVisible(harnessId: string, visible: boolean, projectId?: string | null): void {
    const next = new Set(snapshot.visible);
    if (visible) next.add(harnessId);
    else next.delete(harnessId);
    publish({ ...snapshot, visible: next });
    if (visible) {
        notices.get(harnessId)?.dismiss();
        notices.delete(harnessId);
        return;
    }
    const job = snapshot.projects.get(projectKey(projectId))?.get(harnessId);
    if (job && installIsActive(job)) {
        backgrounded.add(harnessId);
        notifyProgress(job);
    }
}

/** Runs after any followed install ends (succeeded, failed or stopped). */
export function onHarnessInstallSettled(listener: (job: HarnessInstallDto) => void): () => void {
    settledListeners.add(listener);
    return () => { settledListeners.delete(listener); };
}

export function consumeInstallRequest(seq: number): void {
    if (snapshot.requested?.seq === seq) {
        const { requested: _requested, ...rest } = snapshot;
        publish(rest);
    }
}

/** Installs for one project, loaded on first use and followed while they run. */
export function useHarnessInstalls(projectId: string | null | undefined, host: WebPackageHost) {
    const current = useSyncExternalStore(subscribe, () => snapshot);
    useEffect(() => { boundHost = host; }, [host]);
    useEffect(() => { void loadHarnessInstalls(projectId); }, [projectId]);
    const refresh = useCallback(() => loadHarnessInstalls(projectId), [projectId]);
    return {
        jobs: current.projects.get(projectKey(projectId)) ?? empty,
        requested: current.requested,
        refresh,
    };
}

/** Test seam: forget every install and timer. */
export function resetHarnessInstallsForTest(): void {
    for (const timer of polls.values()) clearTimeout(timer);
    polls.clear();
    notices.clear();
    backgrounded.clear();
    settled.clear();
    misses.clear();
    settledListeners.clear();
    boundHost = undefined;
    snapshot = { projects: new Map(), visible: new Set() };
}
