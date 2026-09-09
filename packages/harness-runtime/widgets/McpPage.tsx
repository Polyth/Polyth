import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpTransport } from "@polyth/contracts";
import type {
  CapabilityInstallationScope,
  McpInstallationDto,
} from "@polyth/contracts/capability-installations";
import { createApiTransport } from "@polyth/web-sdk";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { Button, IconButton, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { DeleteIcon } from "../../../apps/web/src/components/ui/icons.ts";
import { EmptyState, PageHead, Seg } from "../../../apps/web/src/components/settings/parts.tsx";

const api = createApiTransport();
const SCOPE_OPTIONS: Array<{ value: CapabilityInstallationScope; label: string }> = [
  { value: "project", label: "This project" },
  { value: "space", label: "This Space · all projects" },
];

const queryFor = (projectId?: string): string =>
  projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

type SelectionRef = { current: string };

function McpServerForm({
  existing,
  projectId,
  selectionKey,
  selectionRef,
  onDone,
}: {
  existing?: McpInstallationDto;
  projectId?: string;
  selectionKey: string;
  selectionRef: SelectionRef;
  onDone: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<"stdio" | "http">(existing?.transport.kind ?? "stdio");
  const [command, setCommand] = useState(existing?.transport.kind === "stdio" ? existing.transport.command : "");
  const [args, setArgs] = useState(existing?.transport.kind === "stdio" ? existing.transport.args.join(" ") : "");
  const [url, setUrl] = useState(existing?.transport.kind === "http" ? existing.transport.url : "");
  const [secretRows, setSecretRows] = useState<Array<{ key: string; value: string }>>(() => {
    if (!existing) return [];
    const keys = existing.transport.kind === "stdio"
      ? existing.transport.envKeys
      : existing.transport.headersSecretRefs;
    return keys.map((key) => ({ key, value: "" }));
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const operationKey = selectionKey;
    setBusy(true);
    setError("");
    try {
      const keys = secretRows.map((row) => row.key.trim()).filter(Boolean);
      if (new Set(keys).size !== keys.length) throw new Error("Secret keys must be unique.");
      const secrets: Record<string, string> = {};
      for (const row of secretRows) {
        if (row.key.trim() && row.value) secrets[row.key.trim()] = row.value;
      }
      const transport: McpTransport = kind === "stdio"
        ? {
            kind: "stdio",
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : [],
            envKeys: keys,
          }
        : { kind: "http", url: url.trim(), headersSecretRefs: keys };
      const query = queryFor(projectId);
      if (existing) {
        await api.patch<McpInstallationDto>(`/api/mcp/servers/${encodeURIComponent(existing.id)}${query}`, {
          name: name.trim(),
          transport,
          ...(Object.keys(secrets).length ? { secrets } : {}),
          expectedRevision: existing.revision,
        });
      } else {
        await api.post<McpInstallationDto>(`/api/mcp/servers${query}`, {
          name: name.trim(),
          transport,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        });
      }
      if (selectionRef.current === operationKey) onDone();
    } catch (cause) {
      if (selectionRef.current === operationKey) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (selectionRef.current === operationKey) setBusy(false);
    }
  };

  return <div className="mcp-form">
    <div className="mcp-form-row">
      <TextInput
        uiSize="sm"
        value={name}
        placeholder="Name"
        className="mcp-server-name"
        onChange={(event) => setName(event.target.value)}
        aria-label="Server name"
      />
      <Seg value={kind} options={[["stdio", "stdio"], ["http", "HTTP"]]} onChange={setKind} />
    </div>
    {kind === "stdio" ? <div className="mcp-form-row">
      <TextInput
        uiSize="sm"
        value={command}
        placeholder="Command (no shell)"
        className="mcp-command"
        onChange={(event) => setCommand(event.target.value)}
        aria-label="Command"
      />
      <TextInput
        uiSize="sm"
        value={args}
        placeholder="Args, space separated"
        onChange={(event) => setArgs(event.target.value)}
        aria-label="Arguments"
      />
    </div> : <div className="mcp-form-row">
      <TextInput
        uiSize="sm"
        value={url}
        placeholder="https://host/mcp"
        onChange={(event) => setUrl(event.target.value)}
        aria-label="Server URL"
      />
    </div>}
    <div className="mcp-secrets">
      <div className="stat-label">
        {kind === "stdio" ? "Environment secrets" : "Header secrets"}
        <span className="muted"> Values stay server-side and are never shown again.</span>
      </div>
      {secretRows.map((row, index) => <div key={`${row.key}-${index}`} className="mcp-form-row">
        <TextInput
          uiSize="sm"
          value={row.key}
          placeholder={kind === "stdio" ? "ENV_KEY" : "Header-Name"}
          className="mcp-secret-key"
          aria-label={kind === "stdio" ? "Environment key" : "Header name"}
          onChange={(event) => setSecretRows((rows) => rows.map((candidate, i) =>
            i === index ? { ...candidate, key: event.target.value } : candidate))}
        />
        <TextInput
          uiSize="sm"
          type="password"
          value={row.value}
          placeholder={existing ? "Leave blank to keep stored value" : "Value"}
          aria-label="Secret value"
          onChange={(event) => setSecretRows((rows) => rows.map((candidate, i) =>
            i === index ? { ...candidate, value: event.target.value } : candidate))}
        />
        <IconButton
          icon={DeleteIcon}
          size="sm"
          variant="danger"
          label="Remove secret"
          onClick={() => setSecretRows((rows) => rows.filter((_, i) => i !== index))}
        />
      </div>)}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setSecretRows((rows) => [...rows, { key: "", value: "" }])}
      >Add secret</Button>
    </div>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="mcp-form-row">
      <Button
        size="sm"
        busy={busy}
        disabled={!name.trim() || (kind === "stdio" ? !command.trim() : !url.trim())}
        onClick={() => void submit()}
      >{existing ? "Save changes" : "Add server"}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
    </div>
  </div>;
}

export default function McpPage() {
  const activeProjectId = useStore((state) => state.activeProjectId);
  const projectRegistry = useStore((state) => state.projectRegistry);
  const project = projectRegistry.status === "ready"
    ? projectRegistry.projects.find((candidate) => candidate.id === activeProjectId)
    : undefined;
  const [scope, setScope] = useState<CapabilityInstallationScope>("project");
  const [servers, setServers] = useState<McpInstallationDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [probeMessage, setProbeMessage] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const projectId = scope === "project" ? activeProjectId ?? undefined : undefined;
  const selectionKey = `${scope}:${projectId ?? "space"}`;
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;

  const scopeLabel = useMemo(() => scope === "project"
    ? `This project · ${project?.name ?? activeProjectId ?? "none selected"}`
    : "This Space · shared by all projects",
  [scope, project?.name, activeProjectId]);

  const resetTransient = useCallback(() => {
    setAdding(false);
    setEditingId(null);
    setProbeMessage({});
    setError("");
  }, []);
  useEffect(() => resetTransient(), [selectionKey, resetTransient]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (scope === "project" && !projectId) {
      setServers([]);
      return;
    }
    const rows = await api.get<McpInstallationDto[]>(`/api/mcp/servers${queryFor(projectId)}`, signal ? { signal } : undefined);
    if (!signal?.aborted) setServers(rows);
  }, [scope, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void refresh(controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);

  const ownsSelectedScope = useCallback((server: McpInstallationDto): boolean =>
    server.scope === scope
    && (scope === "space" ? server.projectId === undefined : server.projectId === projectId),
  [scope, projectId]);

  const ownerProjectId = (server: McpInstallationDto): string | undefined =>
    server.scope === "project" ? server.projectId : undefined;

  const probe = async (server: McpInstallationDto) => {
    const operationKey = selectionKey;
    try {
      const result = await api.post<{ ok: boolean; message: string }>(
        `/api/mcp/servers/${encodeURIComponent(server.id)}/probe${queryFor(ownerProjectId(server))}`,
      );
      if (selectionRef.current !== operationKey) return;
      setProbeMessage((messages) => ({ ...messages, [server.id]: `${result.ok ? "✓" : "✗"} ${result.message}` }));
      await refresh();
    } catch (cause) {
      if (selectionRef.current === operationKey) {
        setProbeMessage((messages) => ({
          ...messages,
          [server.id]: `✗ ${cause instanceof Error ? cause.message : String(cause)}`,
        }));
      }
    }
  };

  const toggle = async (server: McpInstallationDto) => {
    if (!ownsSelectedScope(server)) return;
    const operationKey = selectionKey;
    setError("");
    try {
      await api.patch<McpInstallationDto>(
        `/api/mcp/servers/${encodeURIComponent(server.id)}${queryFor(projectId)}`,
        { enabled: !server.enabled, expectedRevision: server.revision },
      );
      if (selectionRef.current === operationKey) await refresh();
    } catch (cause) {
      if (selectionRef.current === operationKey) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (server: McpInstallationDto) => {
    if (!ownsSelectedScope(server)) return;
    const where = scope === "project" ? `project ${project?.name ?? projectId}` : "this Space";
    if (!await confirmAlert(`Remove MCP server "${server.name}" from ${where}?`, {
      title: "Remove MCP server",
      confirmLabel: "Remove",
    })) return;
    const operationKey = selectionKey;
    setError("");
    try {
      await api.delete<{ ok: boolean }>(
        `/api/mcp/servers/${encodeURIComponent(server.id)}${queryFor(projectId)}`,
      );
      if (selectionRef.current === operationKey) await refresh();
    } catch (cause) {
      if (selectionRef.current === operationKey) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <>
    <PageHead
      title="MCP"
      blurb="Polyth resolves the effective project MCP set and provisions it to every compatible harness. A project entry overrides a same-named Space entry without changing other projects."
    />
    <div className="set-add-form">
      <Select
        label={scopeLabel}
        value={scope}
        options={SCOPE_OPTIONS}
        onChange={(value) => setScope(value as CapabilityInstallationScope)}
      />
      <span className="set-row-hint">Installing into: {scopeLabel}</span>
    </div>

    {scope === "project" && !activeProjectId
      ? <EmptyState title="No active project" body="Select a project before installing a project-scoped MCP, or switch to This Space." />
      : !loading && servers.length === 0 && !adding
        ? <EmptyState title="No MCP servers configured" body="Add a stdio or HTTP server for the selected scope." />
        : null}

    <div className="mcp-list" data-settings-item="mcp.servers">
      {servers.map((server) => {
        const editable = ownsSelectedScope(server);
        const inherited = scope === "project" && server.scope === "space";
        if (editingId === server.id && editable) {
          return <McpServerForm
            key={server.id}
            existing={server}
            projectId={projectId}
            selectionKey={selectionKey}
            selectionRef={selectionRef}
            onDone={() => { setEditingId(null); void refresh(); }}
          />;
        }
        return <div key={server.id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">{server.name}</div>
            <div className="set-row-hint mono">
              {server.transport.kind === "stdio"
                ? `${server.transport.command} ${server.transport.args.join(" ")}`.trim()
                : server.transport.url}
              {server.transport.kind === "stdio" && server.transport.envKeys.length > 0
                ? <span className="secret-redacted"> env {server.transport.envKeys.join(", ")}</span>
                : null}
              {server.transport.kind === "http" && server.transport.headersSecretRefs.length > 0
                ? <span className="secret-redacted"> headers {server.transport.headersSecretRefs.join(", ")}</span>
                : null}
            </div>
            <div className="set-row-hint">
              {inherited ? "Inherited from this Space · read-only here" : server.scope === "project" ? "This project" : "This Space"}
            </div>
            {(probeMessage[server.id] || server.lastError) && <div className="set-row-hint">{probeMessage[server.id] ?? server.lastError}</div>}
          </div>
          <div className="set-row-control">
            <span className={`tag mcp-status ${server.status}`}>{server.status}</span>
            <Button size="sm" title="Check reachability" onClick={() => void probe(server)}>Probe</Button>
            {editable && <Button size="sm" onClick={() => setEditingId(server.id)}>Edit</Button>}
            {editable && <Button size="sm" onClick={() => void toggle(server)}>{server.enabled ? "Disable" : "Enable"}</Button>}
            {editable && <Button size="sm" variant="danger" onClick={() => void remove(server)}>Remove</Button>}
          </div>
        </div>;
      })}
    </div>

    {adding && <McpServerForm
      projectId={projectId}
      selectionKey={selectionKey}
      selectionRef={selectionRef}
      onDone={() => { setAdding(false); void refresh(); }}
    />}
    {!adding && (scope !== "project" || activeProjectId) && <div className="mcp-form-row">
      <Button size="sm" onClick={() => setAdding(true)}>Add MCP server</Button>
    </div>}
    {error && <div className="form-error" role="alert">{error}</div>}
  </>;
}
