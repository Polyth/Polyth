import "./styles.css";
import { useEffect, useState } from "react";
import type { HarnessDescriptor, HarnessProbe, HarnessSelection, SessionProjection } from "@polyth/contracts";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { Button, Dialog, Notice, Select, Switch } from "../../../apps/web/src/components/ui/index.ts";
import { activateSession, upsertSession, useStore } from "../../../apps/web/src/store.ts";
const api = createApiTransport();
type Row = HarnessDescriptor & HarnessProbe & {
    enabled: boolean;
};
const status = (row: Row) => !row.installed ? "Install" : !row.healthy ? "Unavailable" : row.authenticated === false ? "Sign in" : row.authenticated === "unknown" ? "Check sign-in" : "Ready";
function useHarnesses(projectId?: string | null) {
    const [rows, setRows] = useState<Row[]>([]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const refresh = async () => { setLoading(true); try {
        setRows(await api.get<Row[]>(`/api/harnesses${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`));
        setError("");
    }
    catch (e) {
        setError(String((e as Error).message));
    }
    finally {
        setLoading(false);
    } };
    useEffect(() => { void refresh(); }, [projectId]);
    return { rows, error, loading, refresh };
}
function HarnessPicker({ host, projectId, sessionId }: {
    host: WebPackageHost;
    projectId?: string;
    sessionId?: string;
}) {
    const session = useStore((s) => s.sessions.find((item) => item.id === sessionId));
    const { rows, error, refresh } = useHarnesses(projectId);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState("");
    const selection = session?.harnessTransition?.selection ?? session?.harness ?? { mode: "auto" };
    const change = async (next: HarnessSelection, timing: "after-turn" | "stop-now" = "after-turn") => {
        setBusy(true);
        setFailure("");
        try {
            const result = sessionId
                ? await api.post<SessionProjection>(`/api/harnesses/sessions/${encodeURIComponent(sessionId)}`, { selection: next, timing })
                : await api.post<SessionProjection>("/api/harnesses/sessions", { projectId, selection: next });
            upsertSession(result);
            if (!sessionId)
                activateSession(result.id);
        }
        catch (e) {
            setFailure(host.errors.friendly("Change harness", e));
        }
        finally {
            setBusy(false);
        }
    };
    const current = rows.find((row) => row.id === session?.resolvedHarnessId);
    return <div className="pkg-harnesses pkg-harnesses-picker">
    <Select label="Harness" ariaLabel="Execution harness" value={selection.mode === "auto" ? "auto" : selection.harnessId} disabled={busy || !projectId || Boolean(session?.harnessTransition)} options={[{ value: "auto", label: current ? `Auto · ${current.name}` : "Auto", detail: "Keep the selected harness for this session" }, ...rows.filter((row) => row.enabled && row.installed && row.healthy).map((row) => ({ value: row.id, label: row.name, detail: status(row) }))]} onChange={(id) => void change(id === "auto" ? { mode: "auto" } : { mode: "pinned", harnessId: id })}/>
    {current && selection.mode === "pinned" && <span className="pkg-harnesses-muted">via {current.name}</span>}
    <Button size="sm" variant="ghost" onClick={() => { host.navigation.openSettingsPage("harnesses"); void refresh(); }}>Harness settings</Button>
    {session?.harnessTransition && <Notice>Switch to {rows.find((r) => r.id === session.harnessTransition!.targetHarnessId)?.name ?? session.harnessTransition.targetHarnessId} {session.harnessTransition.phase === "released" ? "is being recovered" : "after this turn"}.
      <Button size="sm" busy={busy} onClick={() => void change(session.harnessTransition!.selection, "stop-now")}>Stop and switch now</Button>
    </Notice>}
    {(failure || error) && <Notice tone="error" role="alert">{failure || error}</Notice>}
  </div>;
}
function HarnessSettings({ host }: {
    host: WebPackageHost;
}) {
    const projectId = host.store.select((s) => s.activeProjectId);
    const { rows, error, loading, refresh } = useHarnesses(projectId);
    const [failure, setFailure] = useState("");
    const [busy, setBusy] = useState(false);
    const [setup, setSetup] = useState<{
        row: Row;
        command: string;
        label: string;
    }>();
    const [terminal, setTerminal] = useState<string>();
    useEffect(() => {
        const focus = () => { void refresh(); };
        window.addEventListener("focus", focus);
        if (!terminal)
            return () => window.removeEventListener("focus", focus);
        const interval = setInterval(() => {
            void api.get<Array<{
                id: string;
                running: boolean;
            }>>(`/api/terminals?projectId=${encodeURIComponent(projectId ?? "")}`).then((items) => {
                if (!items.find((item) => item.id === terminal)?.running) {
                    setTerminal(undefined);
                    void refresh();
                }
            }).catch(() => setTerminal(undefined));
        }, 3000);
        return () => { window.removeEventListener("focus", focus); clearInterval(interval); };
    }, [projectId, terminal]);
    const save = async (row: Row, patch: Partial<Row>) => {
        setBusy(true);
        setFailure("");
        try {
            await api.put("/api/harnesses/preferences", { preferences: Object.fromEntries(rows.map((r) => [r.id, { enabled: r.id === row.id ? patch.enabled ?? r.enabled : r.enabled, priority: r.id === row.id ? patch.priority ?? r.priority : r.priority }])) });
            await refresh();
        }
        catch (e) {
            setFailure(host.errors.friendly("Save harness preferences", e));
        }
        finally {
            setBusy(false);
        }
    };
    const runSetup = async () => {
        if (!setup || !projectId)
            return;
        setBusy(true);
        setFailure("");
        try {
            const result = await api.post<{
                terminalId: string;
            }>("/api/terminals", { projectId, cmd: setup.command });
            setTerminal(result.terminalId);
            setSetup(undefined);
            host.navigation.setOverlay(null);
            host.navigation.openWorkspacePane("terminal");
        }
        catch (e) {
            setFailure(host.errors.friendly("Run native setup", e));
        }
        finally {
            setBusy(false);
        }
    };
    return <div className="pkg-harnesses pkg-harnesses-settings">
    <p>Choose which coding agents Auto can use. Existing sessions keep their current harness. Native sign-in stays with the coding agent.</p>
    <Button size="sm" busy={loading} onClick={() => void refresh()}>Refresh detection</Button>
    {(error || failure) && <Notice tone="error" role="alert">{failure || error}</Notice>}
    {!loading && !rows.some((r) => r.installed && r.healthy && r.enabled) && <Notice>Set up a harness below to start a session.</Notice>}
    {rows.toSorted((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map((row) => <section className="pkg-harnesses-row" key={row.id}>
      <div className="pkg-harnesses-line"><Switch label={`Enable ${row.name}`} checked={row.enabled} disabled={busy} onChange={(enabled) => void save(row, { enabled })}/><strong>{row.name}</strong><span className="pkg-harnesses-muted">{status(row)}</span></div>
      <div className="pkg-harnesses-line">
        <label>Auto priority <Select label={`${row.name} priority`} value={String(row.priority)} options={[...new Set([0, 10, 20, 30, 40, 50, row.priority])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: String(n) }))} disabled={busy} onChange={(priority) => void save(row, { priority: Number(priority) })}/></label>
        {(!row.installed ? row.installCommand : row.signInCommand) && <Button size="sm" disabled={!projectId} onClick={() => setSetup({ row, command: (!row.installed ? row.installCommand : row.signInCommand)!, label: !row.installed ? "Install" : "Sign in" })}>{!row.installed ? "Install" : "Sign in"}</Button>}
        {row.setupUrl && <a href={row.setupUrl} target="_blank" rel="noreferrer">Official setup</a>}
      </div>
      <details><summary>Diagnostics</summary><p>{row.integration} · {row.version ?? "Version unavailable"}</p><p>{row.message ?? (row.autoSelect === false ? "Select explicitly; native authentication cannot yet be verified for Auto." : "Lower priority numbers are tried first.")}</p></details>
    </section>)}
    {setup && <Dialog title={`${setup.label} ${setup.row.name}`} onClose={() => setSetup(undefined)}><div className="pkg-harnesses"><p>Run this native command in your project terminal:</p><pre className="pkg-harnesses-command">{setup.command}</pre><Button busy={busy} onClick={() => void runSetup()}>Run command</Button></div></Dialog>}
  </div>;
}
function SwitchMarker() {
    const event = useStore((s) => s.activeSessionId ? s.events[s.activeSessionId]?.findLast((e) => e.type === "harness/switched") : undefined);
    return event ? <p className="pkg-harnesses pkg-harnesses-muted" role="status">Continued with {String(event.data.to)} · same conversation and workspace</p> : null;
}
export default defineWebPackage((host) => () => {
    const off = [
        host.settings.registerPage({ id: "harnesses", packageId: "harness-runtime", label: "Harnesses", group: "Engineering", order: 15, component: () => <HarnessSettings host={host}/> }),
        host.slots.register({ id: "harnesses.selector", slot: "composer.meta", order: 10, render: (props) => <HarnessPicker host={host} projectId={props.projectId as string | undefined} sessionId={props.sessionId as string | undefined}/> }),
        host.slots.register({ id: "harnesses.switch-marker", slot: "session.timeline.after", render: () => <SwitchMarker /> }),
    ];
    return () => off.toReversed().forEach((dispose) => dispose());
});
