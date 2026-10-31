// Plain-language copy for background harness installs. DOM-free so the
// wording rules (machine names, failure help, the step after installing) are
// tested without mounting the dialog.
import type { HarnessInstallDto, HarnessInstallPhase, HarnessInstallPreviewDto, HarnessSnapshot } from "@polyth/contracts";

/** Looks up a key under `harnessruntime.install.` (the caller adds the
 *  prefix), so the wording here stays readable. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

const ACTIVE: ReadonlySet<HarnessInstallPhase> = new Set(["queued", "running", "verifying"]);
export const installIsActive = (job: Pick<HarnessInstallDto, "phase"> | undefined): boolean => Boolean(job && ACTIVE.has(job.phase));

/** "on this Mac" for sentences, "This Mac" for the details list. A browser
 *  on another device (a phone, Polyth Link) is told which machine it is. */
export function machineWords(preview: Pick<HarnessInstallPreviewDto, "machine" | "browserOnMachine">, t: Translate): { on: string; title: string } {
    const { machine } = preview;
    if (machine.kind === "remote") return { on: t("machine.onRemote", { label: machine.label }), title: machine.label };
    const kind = machine.os === "darwin" ? "Mac" : machine.os === "win32" ? "Pc" : "Computer";
    const who = preview.browserOnMachine ? "this" : "server";
    return { on: t(`machine.on${who === "this" ? "This" : "Server"}${kind}`), title: t(`machine.${who}${kind}`) };
}

export const osWords = (preview: Pick<HarnessInstallPreviewDto, "machine">, t: Translate): string =>
    preview.machine.kind === "remote" ? t("os.ssh") : t(`os.${preview.machine.os}`);

/** "antigravity.google", "nodejs.org and registry.npmjs.org". */
export function sourceList(sources: readonly string[], locale?: string): string {
    if (sources.length < 2) return sources[0] ?? "";
    try {
        return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(sources);
    } catch {
        return sources.join(", ");
    }
}

/** `0:42`, `12:05`, `1:02:09`. */
export function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export type InstallStepState = "pending" | "active" | "done" | "failed";
export type InstallStep = { id: "install" | "verify" | "ready"; state: InstallStepState };

/** The three honest stages: the installer runs, Polyth checks it, ready. */
export function installSteps(job: Pick<HarnessInstallDto, "phase" | "failure">): InstallStep[] {
    const states: Record<HarnessInstallPhase, [InstallStepState, InstallStepState, InstallStepState]> = {
        queued: ["pending", "pending", "pending"],
        running: ["active", "pending", "pending"],
        verifying: ["done", "active", "pending"],
        succeeded: ["done", "done", "done"],
        failed: job.failure?.kind === "not-found-after-install" ? ["done", "failed", "pending"] : ["failed", "pending", "pending"],
        cancelled: ["failed", "pending", "pending"],
    };
    const [install, verify, ready] = states[job.phase];
    return [{ id: "install", state: install }, { id: "verify", state: verify }, { id: "ready", state: ready }];
}

export type FailureCopy = { summary: string; hint: string; quote?: string };

/** What went wrong and what to do, in the person's words. The installer's
 *  raw output stays in Technical details. */
export function failureCopy(job: Pick<HarnessInstallDto, "failure" | "harnessName" | "sources">, words: { on: string }, t: Translate, locale?: string): FailureCopy {
    const name = job.harnessName;
    const failure = job.failure;
    const sources = sourceList(job.sources, locale) || name;
    switch (failure?.kind) {
        case "network": return { summary: t("failure.network"), hint: t("failure.networkHint", { sources }) };
        case "permission": return { summary: t("failure.permission"), hint: t("failure.permissionHint") };
        case "disk-space": return { summary: t("failure.diskSpace"), hint: t("failure.diskSpaceHint", { onMachine: words.on }) };
        case "unsupported-platform": return { summary: t("failure.unsupported", { name }), hint: t("failure.unsupportedHint", { name }) };
        case "checksum": return { summary: t("failure.checksum"), hint: t("failure.checksumHint") };
        case "prerequisite": return {
            summary: t("failure.prerequisite", { onMachine: words.on }),
            hint: failure.tool ? t("failure.prerequisiteTool", { tool: failure.tool }) : t("failure.prerequisiteHint"),
        };
        case "timeout": return { summary: t("failure.timeout"), hint: t("failure.timeoutHint") };
        case "not-found-after-install": return { summary: t("failure.notFound"), hint: t("failure.notFoundHint") };
        case "interrupted": return { summary: t("failure.interrupted"), hint: t("failure.interruptedHint") };
        default: return {
            summary: t("failure.unknown"),
            hint: t("failure.unknownHint"),
            ...(failure?.message ? { quote: failure.message } : {}),
        };
    }
}

export type NextStep = "checking" | "sign-in" | "ready" | "setup" | "none";

/** After a successful install: what the person does next, from the row the
 *  page now shows (Settings re-checks the harness natively after an install).
 *  A fresh CLI whose sign-in cannot be seen yet is offered Sign in; Later
 *  keeps it optional. */
export function nextStepAfterInstall(row: HarnessSnapshot | undefined, checking: boolean): NextStep {
    if (!row || !row.availability.installed) return checking ? "checking" : "none";
    if (checking) return "checking";
    const state = row.availability.state;
    const canSignIn = Boolean(row.setup?.signInCommand);
    if (state === "ready") return "ready";
    if (state === "auth-required" || row.availability.authenticated === false) return canSignIn ? "sign-in" : "setup";
    if (state === "unknown" || state === "starting") return canSignIn ? "sign-in" : "ready";
    return "setup";
}

/** A row's status while an install is on record for it. */
export function rowInstallStatus(job: Pick<HarnessInstallDto, "phase"> | undefined, t: Translate): { label: string; busy: boolean; failed: boolean } | undefined {
    if (!job) return undefined;
    switch (job.phase) {
        case "queued": return { label: t("row.queued"), busy: true, failed: false };
        case "running": return { label: t("row.running"), busy: true, failed: false };
        case "verifying": return { label: t("row.verifying"), busy: true, failed: false };
        case "failed": return { label: t("row.failed"), busy: false, failed: true };
        default: return undefined;
    }
}
