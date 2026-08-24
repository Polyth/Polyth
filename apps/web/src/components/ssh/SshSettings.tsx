// Settings → SSH Remotes: connection inventory CRUD, connect/disconnect,
// status, and the explicit round-trip test (which also probes whether the
// agent runtime is installed on the remote). No secret is ever entered here —
// auth is the user's SSH agent/config or a private-key FILE PATH.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Project } from "@polyth/contracts";
import { api, type SshConnectionWithStatus, type SshTestResultDto } from "../../api.ts";
import { EmptyState, PageHead } from "../settings/parts.tsx";
import {
  connectionTarget,
  emptySshForm,
  formFromConnection,
  formToInput,
  stateBadge,
  validateSshForm,
  type SshFormValues,
} from "./sshUi.ts";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const testSummary = (test: SshTestResultDto): string => {
  if (test.state !== "connected") return test.message ?? test.state;
  const runtime = test.runtime?.ok
    ? `opencode ${test.runtime.version ?? "installed"}`
    : test.runtime?.message ?? "runtime not probed";
  return `round-trip ${test.latencyMs ?? "?"} ms · ${runtime}`;
};

export default function SshSettings() {
  const [items, setItems] = useState<SshConnectionWithStatus[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [form, setForm] = useState<SshFormValues>(emptySshForm);
  const [formError, setFormError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<string, SshTestResultDto>>({});

  const reload = useCallback(async () => {
    try {
      const [list, projectList] = await Promise.all([api.sshConnections(), api.listProjects()]);
      setItems(list.items);
      setProjects(projectList);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const boundCount = (connectionId: string): number =>
    projects.filter((p) => p.remote?.connectionId === connectionId).length;

  const withBusy = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (conn?: SshConnectionWithStatus) => {
    setFormError("");
    if (conn) {
      setEditing(conn.id);
      setForm(formFromConnection(conn));
    } else {
      setEditing("new");
      setForm(emptySshForm);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = validateSshForm(form);
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError("");
    try {
      if (editing === "new") await api.sshCreateConnection(formToInput(form));
      else if (editing) await api.sshUpdateConnection(editing, formToInput(form));
      setEditing(null);
      await reload();
    } catch (cause) {
      setFormError(errorText(cause));
    }
  };

  const set = (patch: Partial<SshFormValues>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <div data-settings-item="ssh-servers">
      <PageHead
        title="SSH servers"
        blurb="Projects opened on a server run their coding agent on that machine over one multiplexed SSH connection. Authentication uses your SSH agent, ssh_config, or a private-key file path — Polyth never stores passwords or keys."
      />

      {items.length === 0 && editing === null && (
        <EmptyState title="No servers yet" body="Add a server to open remote projects on it." />
      )}

      {items.map((conn) => {
        const badge = stateBadge(conn.status?.state);
        const test = tests[conn.id];
        const bound = boundCount(conn.id);
        const busy = busyId === conn.id;
        return (
          <div key={conn.id} className="set-row">
            <div className="set-row-text">
              <div className="set-row-label ssh-row-label">
                {conn.name}
                <span className="tag mono">{connectionTarget(conn)}</span>
                <span className={`tag tag-${badge.tone}`}>{badge.text}</span>
                {bound > 0 && <span className="tag">{bound} project{bound === 1 ? "" : "s"}</span>}
              </div>
              <div className="set-row-hint">
                {conn.authMode === "identity-file" ? `key: ${conn.identityFile}` : "agent / ssh_config"}
                {conn.status?.message ? ` — ${conn.status.message}` : ""}
                {test ? ` — ${testSummary(test)}` : ""}
              </div>
            </div>
            <div className="set-row-control">
              <button
                className="small-btn"
                disabled={busy}
                onClick={() => void withBusy(conn.id, async () => {
                  const result = await api.sshTest(conn.id);
                  setTests((current) => ({ ...current, [conn.id]: result }));
                  await reload();
                })}
              >
                {busy ? "Working…" : "Test"}
              </button>
              {conn.status?.state === "connected" ? (
                <button
                  className="small-btn"
                  disabled={busy}
                  onClick={() => void withBusy(conn.id, async () => { await api.sshDisconnect(conn.id); await reload(); })}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className="small-btn"
                  disabled={busy}
                  onClick={() => void withBusy(conn.id, async () => { await api.sshConnect(conn.id); await reload(); })}
                >
                  Connect
                </button>
              )}
              <button className="small-btn" disabled={busy} onClick={() => startEdit(conn)}>Edit</button>
              <button
                className="small-btn danger-btn"
                disabled={busy}
                title={bound > 0 ? "Remove the bound projects first" : "Delete this server"}
                onClick={() => void withBusy(conn.id, async () => { await api.sshDeleteConnection(conn.id); await reload(); })}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}

      {editing === null && (
        <div className="set-add-form">
          <button className="small-btn" onClick={() => startEdit()}>+ Server</button>
        </div>
      )}

      {editing !== null && (
        <form className="set-add-form set-add-col" onSubmit={(event) => void submit(event)}>
          <div className="stat-label">{editing === "new" ? "Add server" : "Edit server"}</div>
          <div className="set-add-form">
            <input value={form.name} placeholder="Name (e.g. build box)" aria-label="Server name" onChange={(e) => set({ name: e.target.value })} />
            <input value={form.host} placeholder="Host or ssh_config alias" aria-label="Host" spellCheck={false} onChange={(e) => set({ host: e.target.value })} />
          </div>
          <div className="set-add-form">
            <input value={form.user} placeholder="User (optional)" aria-label="User" spellCheck={false} onChange={(e) => set({ user: e.target.value })} />
            <input value={form.port} placeholder="Port (22)" aria-label="Port" inputMode="numeric" style={{ maxWidth: 110 }} onChange={(e) => set({ port: e.target.value })} />
            <select
              value={form.authMode}
              aria-label="Authentication"
              onChange={(e) => set({ authMode: e.target.value === "identity-file" ? "identity-file" : "agent" })}
            >
              <option value="agent">SSH agent / ssh_config</option>
              <option value="identity-file">Private-key file path</option>
            </select>
          </div>
          {form.authMode === "identity-file" && (
            <div className="set-add-form">
              <input value={form.identityFile} placeholder="~/.ssh/id_ed25519" aria-label="Identity file" spellCheck={false} onChange={(e) => set({ identityFile: e.target.value })} />
            </div>
          )}
          <div className="set-row-hint">
            Password login is not supported — keys or an agent only, so no secret ever reaches Polyth.
          </div>
          {formError && <div className="form-error" role="alert">{formError}</div>}
          <div className="set-add-form">
            <button type="submit" className="small-btn">{editing === "new" ? "Add server" : "Save changes"}</button>
            <button type="button" className="small-btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}
