// Browser-safe shared request and command-review flow for project CLI panels.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createApiTransport, type SurfaceComponentProps, type WebPackageHost } from "@polyth/web-sdk";
import type { ToolCommandPreview } from "../src/projectToolTypes.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import "./tool-command.css";

const api = createApiTransport();

export function useProjectToolScope(host: WebPackageHost, props: SurfaceComponentProps) {
  const project = useSyncExternalStore(host.store.subscribe, () => host.store.getSnapshot().activeProjectId);
  const session = useSyncExternalStore(host.store.subscribe, () => host.store.getSnapshot().activeSessionId);
  return {
    projectId: props.projectId === undefined ? project : props.projectId,
    sessionId: props.sessionId === undefined ? session : props.sessionId,
  };
}

export function toolQuery(input: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value) query.set(key, value);
  return query.toString();
}

/** A late result never changes the newly selected project/configuration. */
export function useToolSnapshot<T>(host: WebPackageHost, path: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ path: string; data: T | null; error: string; loading: boolean }>({ path: "", data: null, error: "", loading: false });
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    setState({ path, data: null, error: "", loading: true });
    void api.get<T>(path, { signal: abort.signal }).then((data) => {
      if (!abort.signal.aborted) setState({ path, data, error: "", loading: false });
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setState({ path, data: null, error: host.errors.friendly(tr("terminalview.toolsLoadWorkspace"), error), loading: false });
    });
    return () => abort.abort();
  }, [host, path, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { data: state.path === path ? state.data : null, error: state.path === path ? state.error : "", loading: !!path && (state.path !== path || state.loading), refresh };
}

export function useToolCommand(host: WebPackageHost, endpoint: string, scopeKey: string) {
  const [prepared, setPrepared] = useState<{ key: string; preview: ToolCommandPreview } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setPrepared(null); setError(""); setBusy(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [scopeKey]);
  const prepare = async (input: object) => {
    if (request.current) return;
    const abort = new AbortController();
    request.current = abort;
    setError(""); setBusy(true);
    try {
      const result = await api.post<ToolCommandPreview>(endpoint, input, { signal: abort.signal });
      if (!abort.signal.aborted) setPrepared({ key: scopeKey, preview: result });
    } catch (cause) {
      if (!abort.signal.aborted) setError(host.errors.friendly(tr("terminalview.toolsPrepareCommand"), cause));
    } finally {
      if (request.current === abort) { request.current = null; setBusy(false); }
    }
  };
  return { preview: prepared?.key === scopeKey ? prepared.preview : null, error, busy, prepare, close: () => setPrepared(null) };
}

/** Execution remains owned by Terminal, with one explicit dispatch and no retry. */
export function ToolCommandDialog({ host, preview, onClose }: { host: WebPackageHost; preview: ToolCommandPreview; onClose(): void }) {
  const { Button } = host.ui.components;
  const Dialog = host.ui.Dialog;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dispatched = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async () => {
    if (dispatched.current) return;
    dispatched.current = true;
    setBusy(true);
    try {
      await api.post("/api/terminals", { projectId: preview.projectId, sessionId: preview.sessionId, repositoryId: preview.repositoryId, cwd: preview.cwd, cmd: preview.cmd });
      if (mounted.current) { host.navigation.openWorkspacePane("terminal"); onClose(); }
    } catch (cause) {
      if (mounted.current) setError(host.errors.friendly(tr("terminalview.toolsOpenTerminal"), cause));
    } finally { if (mounted.current) setBusy(false); }
  };
  return <Dialog title={preview.title} onClose={onClose}>
    <div className="terminal-tool-command">
      <p>{preview.explanation}</p>
      <dl><dt>{tr("terminalview.workingDirectory")}</dt><dd>{preview.cwd}</dd></dl>
      <pre>{preview.cmd}</pre>
      {error && <><p role="alert">{error}</p><p>{tr("terminalview.toolsCheckTerminal")}</p></>}
      <div className="terminal-tool-command__actions">
        <Button size="sm" variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button>
        {error ? <Button size="sm" onClick={() => { host.navigation.openWorkspacePane("terminal"); onClose(); }}>{tr("terminalview.checkTerminal")}</Button>
          : <Button size="sm" variant="primary" busy={busy} disabled={dispatched.current} onClick={() => void run()}>{tr("terminalview.runInTerminal")}</Button>}
      </div>
    </div>
  </Dialog>;
}
