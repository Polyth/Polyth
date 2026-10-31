// Settings → SSH remotes. Three views on one page:
// - the server list (status at a glance, opens a server);
// - a server: connect/check, the enabled harnesses on that machine (install,
//   configuration source) and the connection facts;
// - the add/edit form.
// Shared (installation) connections authenticate with the server's SSH agent,
// config or a private-key FILE PATH. A personal connection (Spaces §14.6)
// authenticates only with a key its owner uploads through SshKeyDialog; the
// key is never read back. Harness credentials stay on each machine.
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type {
  Project,
  SshHarnessConfigSource,
  SshRemoteHarnessDto,
  SshRemoteHarnessesDto,
} from "@polyth/contracts";
import { api, type SshConnectionWithStatus } from "@polyth/session/web-api";
import {
  EmptyState,
  FormField,
  ReadonlyRow,
  Row,
  Section,
  Seg,
  PageHead,
} from "../../../../apps/web/src/components/settings/parts.tsx";
import {
  BackIcon,
  Button,
  ChevronRightIcon,
  Dialog,
  ExternalLinkIcon,
  Icon,
  Notice,
  RefreshIcon,
  Select,
  ServerIcon,
  TabPanel,
  Tabs,
  TextInput,
  confirmAlert,
} from "../../../../apps/web/src/components/ui/index.ts";
import {
  connectionSummary,
  connectionTarget,
  emptySshForm,
  formFromConnection,
  formToInput,
  harnessStatus,
  nextHarnessConfig,
  stateBadge,
  validateSshForm,
  type SshFormValues,
} from "./sshUi.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import {
  accessEditable,
  addOwnerChoices,
  groupConnections,
  isEditable,
  isPersonal,
  sshAccessSummary,
  type SshConnectionList,
  type SshConnectionView,
} from "./sshAccess.ts";
import { SshAccessDialog, SshKeyDialog, useAccessChoices } from "./SshDialogs.tsx";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type ServerTab = "harnesses" | "connection";

interface HarnessState {
  data?: SshRemoteHarnessesDto;
  loading: boolean;
  error?: string;
}

function StatusDot({ tone }: { tone: "ok" | "muted" | "err" }) {
  return <span className="ssh-dot" data-tone={tone} aria-hidden="true" />;
}

export default function SshSettings() {
  const [items, setItems] = useState<SshConnectionView[]>([]);
  const [canAdd, setCanAdd] = useState<Pick<SshConnectionList, "canAddShared" | "canAddPersonal">>({});
  const [addOwner, setAddOwner] = useState<"installation" | "person">("installation");
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<ServerTab>("harnesses");
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [form, setForm] = useState<SshFormValues>(emptySshForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"connect" | "check" | "delete" | null>(null);
  const [error, setError] = useState("");
  const [harnesses, setHarnesses] = useState<Record<string, HarnessState>>({});
  const [installing, setInstalling] = useState<string | null>(null);
  const [review, setReview] = useState<SshRemoteHarnessDto | null>(null);
  const [savingConfig, setSavingConfig] = useState<string | null>(null);
  const tabsId = useId();

  const reload = useCallback(async () => {
    try {
      const [list, projectList] = await Promise.all([api.sshConnections() as Promise<SshConnectionList>, api.listProjects()]);
      setItems(list.items);
      // An older server sends no flags: it let everyone add shared ones.
      setCanAdd("canAddShared" in list || "canAddPersonal" in list
        ? { canAddShared: list.canAddShared === true, canAddPersonal: list.canAddPersonal === true }
        : { canAddShared: true, canAddPersonal: false });
      setProjects(projectList);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const loadHarnesses = useCallback(async (id: string, probe: boolean) => {
    setHarnesses((current) => ({ ...current, [id]: { ...current[id], loading: true } }));
    try {
      const data = await api.sshHarnesses(id, probe);
      setHarnesses((current) => ({
        ...current,
        // A configuration-only refresh keeps what the last probe found.
        [id]: {
          loading: false,
          data: probe || !current[id]?.data?.checkedAt ? data : mergeConfig(current[id]!.data!, data),
        },
      }));
    } catch (cause) {
      setHarnesses((current) => ({ ...current, [id]: { ...current[id], loading: false, error: errorText(cause) } }));
    }
  }, []);

  const selected = items.find((conn) => conn.id === selectedId);
  const ownerChoices = addOwnerChoices(canAdd);
  const choices = useAccessChoices(items.some(accessEditable));
  const replaceItem = (next: SshConnectionView) =>
    setItems((current) => current.map((conn) => conn.id === next.id ? { ...conn, ...next } : conn));
  const connected = selected?.status?.state === "connected";

  // Opening a server lists its harnesses at once; a live connection also
  // checks the host, which costs one command over the shared SSH channel.
  useEffect(() => {
    if (!selectedId) return;
    void loadHarnesses(selectedId, connected);
    // Only on open: later checks are explicit.
  }, [selectedId]);

  const boundProjects = (connectionId: string): Project[] =>
    projects.filter((p) => p.remote?.connectionId === connectionId);

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const openServer = (id: string) => {
    setError("");
    setTab("harnesses");
    setSelectedId(id);
  };

  const startEdit = (conn?: SshConnectionWithStatus) => {
    setFormError("");
    setError("");
    setEditing(conn ? conn.id : "new");
    if (!conn) setAddOwner(ownerChoices[0] ?? "person");
    setForm(conn ? formFromConnection(conn) : emptySshForm);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const personal = editing === "new" ? addOwner === "person" : isPersonal(items.find((conn) => conn.id === editing) ?? {});
    const problem = validateSshForm(form, personal);
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError("");
    setSaving(true);
    try {
      if (editing === "new") {
        const created = await api.sshCreateConnection({ ...formToInput(form, personal), owner: addOwner } as Parameters<typeof api.sshCreateConnection>[0]);
        setSelectedId(created.id);
        // A personal connection cannot sign in until its key is uploaded.
        setTab(personal ? "connection" : "harnesses");
        if (personal) setKeyFor(created.id);
      } else if (editing) {
        await api.sshUpdateConnection(editing, formToInput(form, personal));
      }
      setEditing(null);
      await reload();
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const check = (id: string) => run("check", async () => {
    const status = await api.sshTest(id);
    await reload();
    if (status.state === "connected") await loadHarnesses(id, true);
  });

  const toggleConnection = (conn: SshConnectionWithStatus) => run("connect", async () => {
    if (conn.status?.state === "connected") {
      await api.sshDisconnect(conn.id);
      await reload();
      return;
    }
    const status = await api.sshConnect(conn.id);
    await reload();
    if (status.state === "connected") await loadHarnesses(conn.id, true);
  });

  const remove = async (conn: SshConnectionWithStatus) => {
    const confirmed = await confirmAlert(tr("ssh.sshsettings.deleteServerConfirm", { name: conn.name }), {
      title: tr("ssh.sshsettings.deleteThisServer"),
      confirmLabel: tr("common.delete"),
    });
    if (!confirmed) return;
    await run("delete", async () => {
      await api.sshDeleteConnection(conn.id);
      setSelectedId(null);
      await reload();
    });
  };

  const install = async (conn: SshConnectionWithStatus, harness: SshRemoteHarnessDto) => {
    setReview(null);
    setInstalling(harness.harnessId);
    setError("");
    try {
      const updated = await api.sshInstallHarness(conn.id, harness.harnessId);
      setHarnesses((current) => {
        const state = current[conn.id];
        if (!state?.data) return current;
        return {
          ...current,
          [conn.id]: {
            ...state,
            data: {
              ...state.data,
              items: state.data.items.map((item) => item.harnessId === updated.harnessId ? updated : item),
            },
          },
        };
      });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setInstalling(null);
    }
  };

  const setConfigSource = async (conn: SshConnectionWithStatus, harnessId: string, source: SshHarnessConfigSource) => {
    setSavingConfig(harnessId);
    setError("");
    try {
      await api.sshUpdateConnection(conn.id, { harnessConfig: nextHarnessConfig(conn.harnessConfig, harnessId, source) });
      await reload();
      await loadHarnesses(conn.id, false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSavingConfig(null);
    }
  };

  const set = (patch: Partial<SshFormValues>) => setForm((current) => ({ ...current, ...patch }));

  // ---- add / edit ----------------------------------------------------------
  if (editing !== null) {
    const editingConn = items.find((conn) => conn.id === editing);
    const personalForm = editing === "new" ? addOwner === "person" : isPersonal(editingConn ?? {});
    return (
      <div className="pkg-ssh" data-settings-item="ssh-servers">
        <div className="ssh-nav">
          <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={() => setEditing(null)}>
            {editingConn ? editingConn.name : tr("ssh.sshsettings.sshServers")}
          </Button>
        </div>
        <Section
          title={editing === "new" ? tr("ssh.sshsettings.addServer") : tr("ssh.sshsettings.editServer")}
          hint={personalForm ? tr("ssh.sshsettings.personalFormHint") : tr("ssh.sshsettings.formHint")}
        >
          <form className="ssh-form" onSubmit={(event) => void submit(event)}>
            {editing === "new" && ownerChoices.length > 1 && (
              <div className="ssh-form-owner settings-field">
                <span className="settings-field-label">{tr("ssh.sshsettings.whoCanUse")}</span>
                <Seg
                  value={addOwner}
                  label={tr("ssh.sshsettings.whoCanUseNew")}
                  options={[["installation", tr("ssh.sshsettings.shared")], ["person", tr("ssh.sshsettings.onlyMe")]]}
                  onChange={(value) => setAddOwner(value)}
                />
                <span className="settings-field-hint">{addOwner === "person"
                  ? tr("ssh.sshsettings.onlyYouHint")
                  : tr("ssh.sshsettings.sharedHint")}</span>
              </div>
            )}
            <div className="ssh-form-grid">
              <FormField label={tr("ssh.sshsettings.serverName")} optional>
                <TextInput value={form.name} placeholder={tr("ssh.sshsettings.nameExample")} onChange={(e) => set({ name: e.target.value })} />
              </FormField>
              <FormField label={tr("ssh.sshsettings.host")} hint={tr("ssh.sshsettings.hostHint")}>
                <TextInput value={form.host} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => set({ host: e.target.value })} />
              </FormField>
              <FormField label={tr("ssh.sshsettings.user")} optional>
                <TextInput value={form.user} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => set({ user: e.target.value })} />
              </FormField>
              <FormField label={tr("ssh.sshsettings.port")} optional>
                <TextInput value={form.port} placeholder="22" inputMode="numeric" className="ssh-port-input" onChange={(e) => set({ port: e.target.value })} />
              </FormField>
              {personalForm ? (
                <p className="ssh-form-wide ssh-footnote">
                  {editingConn?.keyUploaded
                    ? "Signs in with the private key you uploaded."
                    : "Signs in only with a private key you upload. You can add it right after saving."}
                </p>
              ) : (
                <>
                <div className="ssh-form-wide">
                  <FormField label={tr("ssh.sshsettings.authentication")} hint={tr("ssh.sshsettings.passwordLoginIsNotSupportedKeysOr")}>
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
                  </FormField>
                </div>
                {form.authMode === "identity-file" && (
                  <div className="ssh-form-wide">
                    <FormField label={tr("ssh.sshsettings.privateKeyFile")} hint={tr("ssh.sshsettings.privateKeyFileHint")}>
                      <TextInput value={form.identityFile} placeholder={tr("ssh.sshsettings.sshIdEd25519")} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => set({ identityFile: e.target.value })} />
                    </FormField>
                  </div>
                )}
                </>
              )}
            </div>
            {formError && <Notice tone="error" role="alert">{formError}</Notice>}
            <div className="ssh-form-actions">
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>{tr("common.cancel")}</Button>
              <Button type="submit" size="sm" variant="primary" busy={saving}>
                {editing === "new" ? tr("ssh.sshsettings.addServer") : tr("ssh.sshsettings.saveChanges")}
              </Button>
            </div>
          </form>
        </Section>
      </div>
    );
  }

  // ---- one server ----------------------------------------------------------
  if (selected) {
    const editable = isEditable(selected);
    const personal = isPersonal(selected);
    const needsKey = personal && !selected.keyUploaded;
    const badge = needsKey && !selected.status?.state
      ? { text: tr("ssh.sshsettings.noKeyYet"), tone: "muted" as const }
      : stateBadge(selected.status?.state);
    const bound = boundProjects(selected.id);
    const state = harnesses[selected.id];
    const list = state?.data;
    const failed = selected.status?.state === "auth-failed" || selected.status?.state === "unreachable";
    const latency = selected.status?.state === "connected" && selected.status.latencyMs !== undefined
      ? tr("ssh.sshsettings.latencyMs", { latency: selected.status.latencyMs })
      : undefined;
    return (
      <div className="pkg-ssh" data-settings-item="ssh-servers">
        <div className="ssh-nav">
          <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={() => setSelectedId(null)}>
            {tr("ssh.sshsettings.sshServers")}
          </Button>
        </div>

        <header className="ssh-server-head">
          <span className="ssh-server-icon" aria-hidden="true"><Icon icon={ServerIcon} size="lg" /></span>
          <div className="ssh-server-title">
            <h2>{selected.name}</h2>
            <p className="ssh-target">{connectionTarget(selected)}</p>
          </div>
          <span className="ssh-state" data-tone={badge.tone}>
            <StatusDot tone={badge.tone} />
            {badge.text}
            {latency && <span className="ssh-state-meta">{latency}</span>}
          </span>
          <div className="ssh-server-actions">
            {needsKey && editable ? (
              <Button size="sm" variant="primary" onClick={() => setKeyFor(selected.id)}>{tr("ssh.sshsettings.uploadKey")}</Button>
            ) : (!connected || editable) && (
              // Disconnecting a shared connection is the server owner's call.
              <Button
                size="sm"
                variant={connected ? "quiet" : "primary"}
                busy={busy === "connect"}
                disabled={busy !== null}
                onClick={() => void toggleConnection(selected)}
              >
                {connected ? tr("ssh.sshsettings.disconnect") : tr("ssh.sshsettings.connect")}
              </Button>
            )}
            <Button
              size="sm"
              variant="quiet"
              iconStart={RefreshIcon}
              busy={busy === "check"}
              disabled={busy !== null}
              onClick={() => void check(selected.id)}
            >
              {tr("ssh.sshsettings.checkNow")}
            </Button>
          </div>
        </header>

        {needsKey && <Notice tone="warning">This server is yours alone and signs in only with a private key you upload. Upload one to connect.</Notice>}
        {!editable && <p className="ssh-footnote ssh-managed-note">Shared by the server owner. You can connect and open projects on it; changing it is not available to you.</p>}
        {failed && selected.status?.message && (
          <Notice tone="error">{selected.status.message}</Notice>
        )}
        {error && <Notice tone="error" role="alert">{error}</Notice>}

        <Tabs
          className="ssh-tabs"
          tabs={[
            { id: "harnesses", label: tr("ssh.sshsettings.harnesses") },
            { id: "connection", label: tr("ssh.sshsettings.connection") },
          ]}
          value={tab}
          onChange={(id) => setTab(id === "connection" ? "connection" : "harnesses")}
          label={tr("ssh.sshsettings.serverSettings", { name: selected.name })}
          size="sm"
          idBase={tabsId}
        />
        <TabPanel idBase={tabsId} tabId={tab} active className="ssh-tab-panel">
          {tab === "harnesses" ? (
            <Section title={tr("ssh.sshsettings.harnessesOnServer")} hint={tr("ssh.sshsettings.harnessesHint")}>
              {!list && state?.loading && <EmptyState compact busy title={tr("ssh.sshsettings.loadingHarnesses")} />}
              {state?.error && <Notice tone="error">{state.error}</Notice>}
              {list?.message && <Notice tone="warning">{tr("ssh.sshsettings.hostNotReached", { message: list.message })}</Notice>}
              {list && !list.checkedAt && !list.message && !state?.loading && (
                <Notice>{tr("ssh.sshsettings.notCheckedYet")}</Notice>
              )}
              {list && list.items.length === 0 && (
                <EmptyState compact title={tr("ssh.sshsettings.noHarnessesEnabled")} body={tr("ssh.sshsettings.noHarnessesEnabledBody")} />
              )}
              {list && list.items.length > 0 && (
                <ul className="ssh-list ssh-harness-list" aria-busy={state?.loading || undefined}>
                  {list.items.map((harness) => (
                    <HarnessRow
                      key={harness.harnessId}
                      harness={harness}
                      installing={installing === harness.harnessId}
                      installDisabled={installing !== null || !connected}
                      manageable={editable}
                      savingConfig={savingConfig === harness.harnessId}
                      onInstall={() => setReview(harness)}
                      onConfig={(source) => void setConfigSource(selected, harness.harnessId, source)}
                    />
                  ))}
                </ul>
              )}
              {list && list.items.some((item) => !item.sessions) && (
                <p className="ssh-footnote">{tr("ssh.sshsettings.sessionsFootnote")}</p>
              )}
              {list && list.items.some((item) => item.localConfig) && (
                <p className="ssh-footnote">{tr("ssh.sshsettings.configFootnote")}</p>
              )}
            </Section>
          ) : (
            <>
              <Section
                title={tr("ssh.sshsettings.connection")}
                {...(editable ? { action: <Button size="sm" variant="quiet" onClick={() => startEdit(selected)}>{tr("common.edit")}</Button> } : {})}
              >
                <ReadonlyRow label={tr("ssh.sshsettings.host")} value={selected.host} mono />
                <ReadonlyRow label={tr("ssh.sshsettings.user")} value={selected.user ?? tr("ssh.sshsettings.fromSshConfig")} {...(selected.user ? { mono: true } : {})} />
                <ReadonlyRow label={tr("ssh.sshsettings.port")} value={selected.port ?? tr("ssh.sshsettings.defaultPort")} />
                {personal ? (
                  <ReadonlyRow
                    label={tr("ssh.sshsettings.authentication")}
                    hint={tr("ssh.sshsettings.keyOnlyForYou")}
                    value={selected.keyUploaded ? tr("ssh.sshsettings.yourUploadedPrivateKey") : tr("ssh.sshsettings.noKeyUploadedYet")}
                    action={editable ? <Button size="sm" variant="quiet" onClick={() => setKeyFor(selected.id)}>{selected.keyUploaded ? tr("ssh.sshsettings.replaceKey") : tr("ssh.sshsettings.uploadKey")}</Button> : undefined}
                  />
                ) : (
                  <ReadonlyRow
                    label={tr("ssh.sshsettings.authentication")}
                    value={selected.authMode === "identity-file"
                      ? tr("ssh.sshsettings.keyFileValue", { identityFile: selected.identityFile ?? "" })
                      : tr("ssh.sshsettings.sshAgentSshConfig")}
                  />
                )}
                <ReadonlyRow
                  label={tr("ssh.sshsettings.belongsTo")}
                  value={personal ? tr("ssh.sshsettings.you") : editable ? tr("ssh.sshsettings.thisServerShared") : tr("ssh.sshsettings.theServerOwner")}
                />
              </Section>
              {accessEditable(selected) && (
                <Section title={tr("ssh.sshsettings.access")} hint={tr("ssh.sshsettings.accessHint")}>
                  <ReadonlyRow
                    label={tr("ssh.sshsettings.whoCanUse")}
                    value={sshAccessSummary(selected, choices.people, choices.spaces)}
                    action={<Button size="sm" variant="quiet" aria-label={tr("ssh.sshsettings.accessFor", { name: selected.name })} onClick={() => setAccessFor(selected.id)}>{tr("ssh.sshsettings.change")}</Button>}
                  />
                </Section>
              )}
              <Section title={tr("ssh.sshsettings.projects")} hint={tr("ssh.sshsettings.projectsHint")}>
                {bound.length === 0
                  ? <p className="ssh-footnote">{tr("ssh.sshsettings.noProjectsYet")}</p>
                  : bound.map((project) => (
                    <ReadonlyRow key={project.id} label={project.name} value={project.path} mono />
                  ))}
              </Section>
              {editable && <Section title={tr("ssh.sshsettings.removeServer")} tone="danger">
                <Row
                  label={tr("ssh.sshsettings.deleteThisServer")}
                  hint={bound.length > 0 ? tr("ssh.sshsettings.removeTheBoundProjectsFirst") : tr("ssh.sshsettings.deleteHint")}
                >
                  <Button size="sm" variant="danger" busy={busy === "delete"} disabled={busy !== null || bound.length > 0} onClick={() => void remove(selected)}>
                    {tr("common.delete")}
                  </Button>
                </Row>
              </Section>}
            </>
          )}
        </TabPanel>

        {review && (
          <Dialog
            title={tr("ssh.sshsettings.installOn", { name: review.name, server: selected.name })}
            onClose={() => setReview(null)}
            footer={(
              <>
                <Button size="sm" variant="ghost" onClick={() => setReview(null)}>{tr("common.cancel")}</Button>
                <Button size="sm" variant="primary" onClick={() => void install(selected, review)}>{tr("ssh.sshsettings.install")}</Button>
              </>
            )}
          >
            <div className="pkg-ssh ssh-review">
              <p>{tr("ssh.sshsettings.installReview", { user: connectionTarget(selected) })}</p>
              <pre className="ssh-command">{review.installCommand}</pre>
            </div>
          </Dialog>
        )}
        {accessFor === selected.id && (
          <SshAccessDialog
            conn={selected}
            people={choices.people}
            spaces={choices.spaces}
            onClose={() => setAccessFor(null)}
            onSaved={(next) => { replaceItem(next); setAccessFor(null); }}
          />
        )}
        {keyFor === selected.id && (
          <SshKeyDialog
            conn={selected}
            onClose={() => setKeyFor(null)}
            onUploaded={(next) => { replaceItem(next); setKeyFor(null); }}
          />
        )}
      </div>
    );
  }

  // ---- server list ---------------------------------------------------------
  const groups = groupConnections(items);
  const canAddAny = ownerChoices.length > 0;
  const renderRows = (rows: SshConnectionView[]) => (
    <ul className="ssh-list">
      {rows.map((conn) => {
        const needsKey = isPersonal(conn) && !conn.keyUploaded;
        const badge = needsKey && !conn.status?.state ? { text: tr("ssh.sshsettings.noKeyYet"), tone: "muted" as const } : stateBadge(conn.status?.state);
        return (
          <li key={conn.id} className="ssh-row">
            <button type="button" className="ssh-row-main" onClick={() => openServer(conn.id)}>
              <StatusDot tone={badge.tone} />
              <span className="ssh-row-copy">
                <strong>{conn.name}</strong>
                <small>
                  <span className="ssh-target">{connectionTarget(conn)}</span>
                  {connectionSummary(conn, boundProjects(conn.id).length).map((fact) => <span key={fact}>{fact}</span>)}
                  {accessEditable(conn) && <span>{sshAccessSummary(conn, choices.people, choices.spaces)}</span>}
                </small>
              </span>
              <span className="ssh-row-state" data-tone={badge.tone}>{badge.text}</span>
              <span className="ssh-row-chevron" aria-hidden="true"><Icon icon={ChevronRightIcon} size="sm" /></span>
            </button>
          </li>
        );
      })}
    </ul>
  );
  const addAction = canAddAny && items.length > 0
    ? { action: <Button size="sm" variant="quiet" onClick={() => startEdit()}>{tr("ssh.sshsettings.addServer")}</Button> }
    : {};
  // Your own servers get their own group once you have one or may add one;
  // otherwise the page keeps the single familiar list.
  const showMine = groups.mine.length > 0 || canAdd.canAddPersonal === true;
  return (
    <div className="pkg-ssh" data-settings-item="ssh-servers">
      <PageHead blurb={tr("ssh.sshsettings.pageBlurb")} />
      {!loaded && <EmptyState compact busy title={tr("ssh.sshsettings.loadingServers")} />}
      {loaded && items.length === 0 && (
        <Section title={tr("ssh.sshsettings.sshServers")} hint={tr("ssh.sshsettings.serversHint")}>
          {canAddAny ? (
            <EmptyState
              compact
              icon="server"
              title={tr("ssh.sshsettings.noServersYet")}
              body={tr("ssh.sshsettings.addAServerToOpenRemoteProjects")}
              action={{ label: tr("ssh.sshsettings.addServer"), onClick: () => startEdit() }}
            />
          ) : (
            <EmptyState
              compact
              icon="server"
              title={tr("ssh.sshsettings.noServersYet")}
              body={tr("ssh.sshsettings.notAvailableBody")}
            />
          )}
        </Section>
      )}
      {loaded && items.length > 0 && showMine && (
        <Section title={tr("ssh.sshsettings.yourServers")} hint={tr("ssh.sshsettings.yourServersHint")} {...addAction}>
          {groups.mine.length > 0
            ? renderRows(groups.mine)
            : <p className="ssh-footnote">{tr("ssh.sshsettings.noneYetBody")}</p>}
        </Section>
      )}
      {loaded && groups.shared.length > 0 && (
        <Section
          title={showMine ? tr("ssh.sshsettings.sharedServers") : tr("ssh.sshsettings.sshServers")}
          hint={canAdd.canAddShared ? tr("ssh.sshsettings.sharedServersHint") : tr("ssh.sshsettings.sharedServersSharedHint")}
          {...(showMine ? {} : addAction)}
        >
          {renderRows(groups.shared)}
          {!canAddAny && <p className="ssh-footnote ssh-quiet-note">{tr("ssh.sshsettings.cannotAddBody")}</p>}
        </Section>
      )}
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </div>
  );
}

function HarnessRow({ harness, installing, installDisabled, manageable, savingConfig, onInstall, onConfig }: {
  harness: SshRemoteHarnessDto;
  installing: boolean;
  installDisabled: boolean;
  /** Installing and choosing configuration change the host: the owner's call. */
  manageable: boolean;
  savingConfig: boolean;
  onInstall: () => void;
  onConfig: (source: SshHarnessConfigSource) => void;
}) {
  const status = installing
    ? { text: tr("ssh.sshsettings.installing"), tone: "muted" as const }
    : harnessStatus(harness);
  const canInstall = manageable && harness.installed === false && harness.installable;
  return (
    <li className="ssh-harness" data-installed={String(harness.installed)}>
      <div className="ssh-harness-main">
        <span className="ssh-row-copy">
          <strong>{harness.name}</strong>
          {harness.sessions && <small><span>{tr("ssh.sshsettings.runsRemoteConversations")}</span></small>}
        </span>
        <span className="ssh-row-state" data-tone={status.tone}>
          <StatusDot tone={status.tone} />
          {status.text}
        </span>
        <span className="ssh-harness-action">
          {canInstall && (
            <Button size="sm" variant="quiet" busy={installing} disabled={installDisabled} onClick={onInstall}>
              {tr("ssh.sshsettings.install")}
            </Button>
          )}
          {harness.installed === false && !harness.installable && harness.setupUrl && (
            <a className="ui-btn ui-btn--ghost ui-btn--sm" href={harness.setupUrl} target="_blank" rel="noreferrer">
              {tr("ssh.sshsettings.setupGuide")}
              <Icon icon={ExternalLinkIcon} size="sm" />
            </a>
          )}
        </span>
      </div>
      {harness.message && <p className="ssh-harness-note">{harness.message}</p>}
      {harness.localConfig && (
        <div className="ssh-harness-config">
          <span className="ssh-harness-config-label">{tr("ssh.sshsettings.configuration")}</span>
          <Seg<SshHarnessConfigSource>
            value={harness.configSource}
            label={tr("ssh.sshsettings.configurationFor", { name: harness.name })}
            disabled={savingConfig || !manageable}
            onChange={onConfig}
            options={[
              ["local", tr("ssh.sshsettings.configLocal")],
              ["remote", tr("ssh.sshsettings.configRemote")],
            ]}
          />
        </div>
      )}
    </li>
  );
}

/** Configuration-only lists carry fresh config sources but no install state. */
function mergeConfig(previous: SshRemoteHarnessesDto, next: SshRemoteHarnessesDto): SshRemoteHarnessesDto {
  return {
    ...previous,
    items: next.items.map((item) => {
      const known = previous.items.find((entry) => entry.harnessId === item.harnessId);
      return known
        ? { ...item, installed: known.installed, ...(known.version ? { version: known.version } : {}) }
        : item;
    }),
  };
}
