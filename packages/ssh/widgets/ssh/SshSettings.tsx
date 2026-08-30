// Settings → SSH Remotes: connection inventory CRUD, connect/disconnect,
// status, and the explicit round-trip test (which also probes whether the
// agent runtime is installed on the remote). No secret is ever entered here —
// auth is the user's SSH agent/config or a private-key FILE PATH.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Project } from "@polyth/contracts";
import { api, type SshConnectionWithStatus, type SshTestResultDto } from "@polyth/session/web-api";
import { EmptyState, PageHead } from "../../../../apps/web/src/components/settings/parts.tsx";
import {
  Button,
  Select,
  TextInput,
} from "../../../../apps/web/src/components/ui/index.ts";
import {
  connectionTarget,
  emptySshForm,
  formFromConnection,
  formToInput,
  stateBadge,
  validateSshForm,
  type SshFormValues,
} from "./sshUi.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const testSummary = (test: SshTestResultDto): string => {
  if (test.state !== "connected") return test.message ?? test.state;
  const runtime = test.runtime?.ok
    ? `opencode ${test.runtime.version ?? tr("settings.sshsettings.installed")}`
    : test.runtime?.message ?? tr("settings.sshsettings.runtimeNotProbed");
  return tr("settings.sshsettings.roundTripValueMsValue", {
    latency: test.latencyMs ?? "?",
    runtime,
  });
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
        title={tr("ssh.sshsettings.sshServers")}
        blurb={tr("ssh.sshsettings.projectsOpenedOnAServerRunTheir")}
      />

      {items.length === 0 && editing === null && (
        <EmptyState title={tr("ssh.sshsettings.noServersYet")} body={tr("ssh.sshsettings.addAServerToOpenRemoteProjects")} />
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
                {bound > 0 && <span className="tag">{bound} {tr("ssh.sshsettings.project")}{bound === 1 ? "" : tr("ssh.sshsettings.s")}</span>}
              </div>
              <div className="set-row-hint">
                {conn.authMode === "identity-file" ? tr("ssh.sshsettings.keyValue", { identityFile: conn.identityFile }) : tr("ssh.sshsettings.agentSshConfig")}
                {conn.status?.message ? ` — ${conn.status.message}` : ""}
                {test ? ` — ${testSummary(test)}` : ""}
              </div>
            </div>
            <div className="set-row-control">
              <Button
                size="sm"
                disabled={busy}
                busy={busy}
                onClick={() => void withBusy(conn.id, async () => {
                  const result = await api.sshTest(conn.id);
                  setTests((current) => ({ ...current, [conn.id]: result }));
                  await reload();
                })}
              >
                {tr("ssh.sshsettings.test")}
              </Button>
              {conn.status?.state === "connected" ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void withBusy(conn.id, async () => { await api.sshDisconnect(conn.id); await reload(); })}
                >
                  {tr("ssh.sshsettings.disconnect")}</Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void withBusy(conn.id, async () => { await api.sshConnect(conn.id); await reload(); })}
                >
                  {tr("ssh.sshsettings.connect")}</Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => startEdit(conn)}>{tr("common.edit")}</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                title={bound > 0 ? tr("ssh.sshsettings.removeTheBoundProjectsFirst") : tr("ssh.sshsettings.deleteThisServer")}
                onClick={() => void withBusy(conn.id, async () => { await api.sshDeleteConnection(conn.id); await reload(); })}
              >
                {tr("common.delete")}</Button>
            </div>
          </div>
        );
      })}

      {editing === null && (
        <div className="set-add-form">
          <Button size="sm" onClick={() => startEdit()}>{tr("ssh.sshsettings.server")}</Button>
        </div>
      )}

      {editing !== null && (
        <form className="set-add-form set-add-col" onSubmit={(event) => void submit(event)}>
          <div className="stat-label">{editing === "new" ? tr("ssh.sshsettings.addServer") : tr("ssh.sshsettings.editServer")}</div>
          <div className="set-add-form">
            <TextInput value={form.name} placeholder={tr("ssh.sshsettings.nameEGBuildBox")} aria-label={tr("ssh.sshsettings.serverName")} onChange={(e) => set({ name: e.target.value })} />
            <TextInput value={form.host} placeholder={tr("ssh.sshsettings.hostOrSshConfigAlias")} aria-label={tr("ssh.sshsettings.host")} spellCheck={false} onChange={(e) => set({ host: e.target.value })} />
          </div>
          <div className="set-add-form">
            <TextInput value={form.user} placeholder={tr("ssh.sshsettings.userOptional")} aria-label={tr("ssh.sshsettings.user")} spellCheck={false} onChange={(e) => set({ user: e.target.value })} />
            <TextInput value={form.port} placeholder={tr("ssh.sshsettings.port22")} aria-label={tr("ssh.sshsettings.port")} inputMode="numeric" style={{ maxWidth: 110 }} onChange={(e) => set({ port: e.target.value })} />
            <Select
              value={form.authMode}
              label={tr("ssh.sshsettings.authentication")}
              ariaLabel={tr("ssh.sshsettings.authentication")}
              onChange={(value) => set({ authMode: value === "identity-file" ? "identity-file" : "agent" })}
              options={[
                { value: "agent", label: tr("ssh.sshsettings.sshAgentSshConfig") },
                { value: "identity-file", label: tr("ssh.sshsettings.privateKeyFilePath") },
              ]}
            />
          </div>
          {form.authMode === "identity-file" && (
            <div className="set-add-form">
              <TextInput value={form.identityFile} placeholder={tr("ssh.sshsettings.sshIdEd25519")} aria-label={tr("ssh.sshsettings.identityFile")} spellCheck={false} onChange={(e) => set({ identityFile: e.target.value })} />
            </div>
          )}
          <div className="set-row-hint">
            {tr("ssh.sshsettings.passwordLoginIsNotSupportedKeysOr")}</div>
          {formError && <div className="form-error" role="alert">{formError}</div>}
          <div className="set-add-form">
            <Button type="submit" size="sm" variant="primary">{editing === "new" ? tr("ssh.sshsettings.addServer") : tr("ssh.sshsettings.saveChanges")}</Button>
            <Button type="button" size="sm" onClick={() => setEditing(null)}>{tr("common.cancel")}</Button>
          </div>
        </form>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}
