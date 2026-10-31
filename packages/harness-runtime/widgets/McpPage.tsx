import "./mcp.css";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HarnessCapabilityStatusDto, McpTransport } from "@polyth/contracts";
import type {
  CapabilityInstallationScope,
  McpAccessDto,
  McpInspectionDto,
  McpInstallationDto,
  McpToolDto,
} from "@polyth/contracts/capability-installations";
import { createApiTransport } from "@polyth/web-sdk";
import type { ReactNode } from "react";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import {
  Badge,
  Button,
  Icon,
  IconButton,
  ProjectPicker,
  Switch,
  Textarea,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  DeleteIcon,
  EditIcon,
  FolderIcon,
  GlobeIcon,
  KeyIcon,
  LayersIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  TerminalIcon,
  UploadIcon,
} from "../../../apps/web/src/components/ui/icons.ts";
import { EmptyState, PageHead, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { getLocaleSnapshot, subscribeLocale } from "../../../apps/web/src/i18n/index.ts";
import { harnessDisplayName } from "./presentation.ts";
import {
  describeTransport,
  nativeStatusLabel,
  nativeTone,
  filterTools,
  formatArgsJson,
  formatCheckedAt,
  inspectionStatus,
  mcpText,
  nativeMcpStatuses,
  parseArgsJson,
  parseMcpServersJson,
  sanitizeImportPreview,
  secretKeys,
  toImportRequestBody,
  validateHttpUrl,
  validateImportBatch,
  validateMcpName,
  validateStdioCommand,
} from "./mcpHelpers.ts";

const api = createApiTransport();
const SERVER_FILTER_THRESHOLD = 5;

/** Re-render when the language changes; copy is read through mcpText at render time. */
function useLocaleRefresh(): void {
  useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
}

/**
 * Render a catalog sentence that wraps part of itself in an element: the
 * message keeps `{name}` placeholders and each is replaced by its node.
 */
function richText(key: string, nodes: Record<string, ReactNode>, values: Record<string, string | number> = {}): ReactNode[] {
  const marked: Record<string, string | number> = { ...values };
  for (const name of Object.keys(nodes)) marked[name] = `\u0001${name}\u0001`;
  return mcpText(key, marked).split(/\u0001(\w+)\u0001/).map((part, index) =>
    index % 2 === 1 ? <Fragment key={index}>{nodes[part]}</Fragment> : part);
}

const queryFor = (projectId?: string): string =>
  projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";

/** Space-owned scopes plus the signed-in person's own servers (§14.6). */
type McpScope = CapabilityInstallationScope | "person";
/** A personal server's URLs never carry a project; Space ones may. */
const serversPath = (personal: boolean, projectId?: string, suffix = ""): string =>
  personal ? `/api/mcp/personal/servers${suffix}` : `/api/mcp/servers${suffix}${queryFor(projectId)}`;
/** Before ownership existed every caller could write; an older server keeps that. */
const LEGACY_ACCESS: McpAccessDto = { canManageSpace: true, canManagePersonal: false };

type SelectionRef = { current: string };
type InstallMode = "http" | "stdio" | "import";
type SecretRow = { key: string; value: string };
type RowBusy = "probe" | "toggle" | "remove" | "override" | "tools";

function useFormActivity(selectionRef: SelectionRef, selectionKey: string) {
  const mounted = useRef(false);
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return {
    current: () => mounted.current && selectionRef.current === selectionKey,
    acquire: () => {
      if (locked.current || !mounted.current || selectionRef.current !== selectionKey) return false;
      locked.current = true;
      return true;
    },
    release: () => { locked.current = false; },
  };
}

const emptySecrets = (): SecretRow[] => [];

function uniqueSecretKeys(rows: SecretRow[]): string[] {
  return rows.map((row) => row.key.trim()).filter(Boolean);
}

function secretsFromRows(rows: SecretRow[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim() && row.value) Object.defineProperty(secrets, row.key.trim(), { value: row.value, enumerable: true, configurable: true });
  }
  return secrets;
}

function statusTone(status: ReturnType<typeof inspectionStatus>): "neutral" | "success" | "warning" | "danger" {
  if (status === "checked") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

function statusHint(status: ReturnType<typeof inspectionStatus>): string | undefined {
  if (status === "unchecked") return mcpText("status.hintUnchecked");
  if (status === "failed") return mcpText("status.hintFailed");
  return undefined;
}

/** Visible label + optional hint around one control; the control keeps its own aria-label. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="pkg-mcp-field">
    <span className="pkg-mcp-field-label" aria-hidden="true">{label}</span>
    {children}
    {hint && <span className="pkg-mcp-help">{hint}</span>}
  </div>;
}

function TransportFields({
  kind,
  url,
  command,
  argsText,
  argsError,
  onUrl,
  onCommand,
  onArgs,
}: {
  kind: "stdio" | "http";
  url: string;
  command: string;
  argsText: string;
  argsError?: string;
  onUrl: (value: string) => void;
  onCommand: (value: string) => void;
  onArgs: (value: string) => void;
}) {
  if (kind === "http") {
    return <Field label={mcpText("field.url")} hint={mcpText("field.urlHint")}>
      <TextInput
        uiSize="sm"
        value={url}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="https://host/mcp"
        onChange={(event) => onUrl(event.target.value)}
        aria-label={mcpText("field.urlAria")}
      />
    </Field>;
  }
  return <div className="pkg-mcp-field-grid">
    <Field label={mcpText("field.command")} hint={mcpText("field.commandHint")}>
      <TextInput
        uiSize="sm"
        value={command}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="mono"
        placeholder="npx"
        onChange={(event) => onCommand(event.target.value)}
        aria-label={mcpText("field.command")}
      />
    </Field>
    <Field label={mcpText("field.arguments")} hint={argsError ?? mcpText("field.argumentsHint")}>
      <TextInput
        uiSize="sm"
        value={argsText}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="mono"
        aria-invalid={argsError ? true : undefined}
        placeholder='["-y","@scope/server"]'
        onChange={(event) => onArgs(event.target.value)}
        aria-label={mcpText("field.argumentsAria")}
      />
    </Field>
  </div>;
}

function McpSecretFields({
  kind,
  existing,
  rows,
  onChange,
}: {
  kind: "stdio" | "http";
  existing?: boolean;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
}) {
  return <div className="pkg-mcp-secrets">
    <div className="pkg-mcp-secrets-label">
      <Icon icon={KeyIcon} size="sm" />
      <span className="pkg-mcp-field-label">{kind === "stdio" ? mcpText("secrets.env") : mcpText("secrets.header")}</span>
      <span className="pkg-mcp-help">{mcpText("secrets.note")}</span>
    </div>
    {rows.map((row, index) => <div key={`secret-${index}`} className="pkg-mcp-secret-row">
      <TextInput
        uiSize="sm"
        value={row.key}
        placeholder={kind === "stdio" ? "ENV_KEY" : "Header-Name"}
        className="pkg-mcp-grow mono"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label={kind === "stdio" ? mcpText("secrets.envKeyAria") : mcpText("secrets.headerNameAria")}
        onChange={(event) => onChange(rows.map((candidate, i) =>
          i === index ? { ...candidate, key: event.target.value } : candidate))}
      />
      <TextInput
        uiSize="sm"
        type="password"
        value={row.value}
        placeholder={existing ? mcpText("secrets.keepPlaceholder") : mcpText("secrets.valuePlaceholder")}
        className="pkg-mcp-grow"
        autoComplete="new-password"
        aria-label={mcpText("secrets.valueAria")}
        onChange={(event) => onChange(rows.map((candidate, i) =>
          i === index ? { ...candidate, value: event.target.value } : candidate))}
      />
      <IconButton
        icon={DeleteIcon}
        size="sm"
        variant="danger"
        label={mcpText("secrets.remove")}
        onClick={() => onChange(rows.filter((_, i) => i !== index))}
      />
    </div>)}
    <div>
      <Button size="sm" variant="ghost" iconStart={PlusIcon} onClick={() => onChange([...rows, { key: "", value: "" }])}>
        {mcpText("secrets.add")}
      </Button>
    </div>
  </div>;
}

function McpServerForm({
  existing,
  projectId,
  personal = false,
  selectionKey,
  selectionRef,
  onDone,
}: {
  existing?: McpInstallationDto;
  projectId?: string;
  personal?: boolean;
  selectionKey: string;
  selectionRef: SelectionRef;
  onDone: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<"stdio" | "http">(existing?.transport.kind ?? "stdio");
  const [command, setCommand] = useState(existing?.transport.kind === "stdio" ? existing.transport.command : "");
  const [argsText, setArgsText] = useState(
    existing?.transport.kind === "stdio" ? formatArgsJson(existing.transport.args) : "",
  );
  const [url, setUrl] = useState(existing?.transport.kind === "http" ? existing.transport.url : "");
  const [secretRows, setSecretRows] = useState<SecretRow[]>(() => {
    if (!existing) return emptySecrets();
    return secretKeys(existing.transport).map((key) => ({ key, value: "" }));
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const activity = useFormActivity(selectionRef, selectionKey);

  const clearSecrets = () => setSecretRows(emptySecrets());

  const finish = () => {
    clearSecrets();
    setError("");
    onDone();
  };

  const submit = async () => {
    if (!activity.acquire()) return;
    setBusy(true);
    setError("");
    try {
      const nameError = validateMcpName(name);
      if (nameError) throw new Error(nameError);
      const keys = uniqueSecretKeys(secretRows);
      if (new Set(keys).size !== keys.length) throw new Error(mcpText("error.secretKeysUnique"));
      const secrets = secretsFromRows(secretRows);
      let transport: McpTransport;
      if (kind === "stdio") {
        const commandError = validateStdioCommand(command);
        if (commandError) throw new Error(commandError);
        const parsed = parseArgsJson(argsText);
        if (parsed.error) throw new Error(parsed.error);
        transport = { kind: "stdio", command: command.trim(), args: parsed.args, envKeys: keys };
      } else {
        const urlError = validateHttpUrl(url);
        if (urlError) throw new Error(urlError);
        transport = { kind: "http", url: url.trim(), headersSecretRefs: keys };
      }
      if (existing) {
        await api.patch<McpInstallationDto>(serversPath(personal, projectId, `/${encodeURIComponent(existing.id)}`), {
          name: name.trim(),
          transport,
          ...(Object.keys(secrets).length ? { secrets } : {}),
          expectedRevision: existing.revision,
        });
      } else {
        await api.post<McpInstallationDto>(serversPath(personal, projectId), {
          name: name.trim(),
          transport,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        });
      }
      if (activity.current()) finish();
    } catch (cause) {
      if (activity.current()) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      activity.release();
      if (activity.current()) setBusy(false);
    }
  };

  const parsedArgs = kind === "stdio" ? parseArgsJson(argsText) : { args: [] as string[] };
  const canSave = !!name.trim()
    && (kind === "stdio" ? !!command.trim() && !parsedArgs.error : !!url.trim());

  return <form
    className="pkg-mcp-panel"
    data-mcp-server={existing?.id}
    aria-label={existing ? mcpText("form.edit", { name: existing.name }) : mcpText("form.title")}
    onSubmit={(event) => { event.preventDefault(); if (canSave) void submit(); }}
  >
    <div className="pkg-mcp-panel-head">
      <h3>{existing ? mcpText("form.edit", { name: existing.name }) : mcpText("form.title")}</h3>
      <p>{mcpText("form.saveNote")}</p>
    </div>
    <div className="pkg-mcp-field-grid">
      <Field label={mcpText("field.name")}>
        <TextInput
          uiSize="sm"
          value={name}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="docs"
          onChange={(event) => setName(event.target.value)}
          aria-label={mcpText("field.nameAria")}
        />
      </Field>
      <Field label={mcpText("field.transport")}>
        <Seg value={kind} options={[["http", mcpText("transport.http")], ["stdio", mcpText("transport.stdio")]]} onChange={setKind} />
      </Field>
    </div>
    <TransportFields
      kind={kind}
      url={url}
      command={command}
      argsText={argsText}
      argsError={parsedArgs.error}
      onUrl={setUrl}
      onCommand={setCommand}
      onArgs={setArgsText}
    />
    <McpSecretFields kind={kind} existing={!!existing} rows={secretRows} onChange={setSecretRows} />
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="pkg-mcp-panel-actions">
      <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={finish}>{mcpText("action.cancel")}</Button>
      <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!canSave}>
        {existing ? mcpText("action.saveChanges") : mcpText("action.addServer")}
      </Button>
    </div>
  </form>;
}

function McpInstallPanel({
  projectId,
  personal = false,
  targetLabel,
  initialMode = "http",
  existingNames,
  selectionKey,
  selectionRef,
  onDone,
}: {
  projectId?: string;
  personal?: boolean;
  targetLabel: string;
  initialMode?: InstallMode;
  existingNames: ReadonlySet<string>;
  selectionKey: string;
  selectionRef: SelectionRef;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<InstallMode>(initialMode);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [secretRows, setSecretRows] = useState<SecretRow[]>(emptySecrets);
  const [importText, setImportText] = useState("");
  const [previewed, setPreviewed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const activity = useFormActivity(selectionRef, selectionKey);

  const parsedImport = useMemo(() => importText.trim() ? parseMcpServersJson(importText) : null, [importText]);
  const importErrors = parsedImport
    ? [...parsedImport.errors, ...validateImportBatch(parsedImport.entries, existingNames)]
    : [];
  const importPreview = parsedImport?.entries.map((entry) => sanitizeImportPreview(entry, existingNames)) ?? [];

  const reset = () => {
    setName("");
    setCommand("");
    setArgsText("");
    setUrl("");
    setSecretRows(emptySecrets());
    setImportText("");
    setPreviewed(false);
    setError("");
  };

  const finish = () => {
    reset();
    onDone();
  };

  const submitManual = async () => {
    if (!activity.acquire()) return;
    setBusy(true);
    setError("");
    try {
      const nameError = validateMcpName(name);
      if (nameError) throw new Error(nameError);
      if (existingNames.has(name.trim())) throw new Error(mcpText("error.nameExists", { name: name.trim() }));
      const keys = uniqueSecretKeys(secretRows);
      if (new Set(keys).size !== keys.length) throw new Error(mcpText("error.secretKeysUnique"));
      const secrets = secretsFromRows(secretRows);
      const transport: McpTransport = mode === "stdio"
        ? (() => {
          const commandError = validateStdioCommand(command);
          if (commandError) throw new Error(commandError);
          const parsed = parseArgsJson(argsText);
          if (parsed.error) throw new Error(parsed.error);
          return { kind: "stdio" as const, command: command.trim(), args: parsed.args, envKeys: keys };
        })()
        : (() => {
          const urlError = validateHttpUrl(url);
          if (urlError) throw new Error(urlError);
          return { kind: "http" as const, url: url.trim(), headersSecretRefs: keys };
        })();
      await api.post<McpInstallationDto>(serversPath(personal, projectId), {
        name: name.trim(),
        transport,
        ...(Object.keys(secrets).length ? { secrets } : {}),
      });
      if (activity.current()) finish();
    } catch (cause) {
      if (activity.current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      activity.release();
      if (activity.current()) setBusy(false);
    }
  };

  const submitImport = async () => {
    if (!parsedImport || parsedImport.entries.length === 0 || importErrors.length > 0) return;
    if (!activity.acquire()) return;
    setBusy(true);
    setError("");
    try {
      await api.post<McpInstallationDto[]>(
        `/api/mcp/servers/import${queryFor(projectId)}`,
        toImportRequestBody(parsedImport.entries),
      );
      if (activity.current()) finish();
    } catch (cause) {
      if (activity.current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      activity.release();
      if (activity.current()) setBusy(false);
    }
  };

  const parsedArgs = mode === "stdio" ? parseArgsJson(argsText) : { args: [] as string[] };
  const canSaveManual = !!name.trim()
    && (mode === "stdio" ? !!command.trim() && !parsedArgs.error : !!url.trim());

  return <form
    className="pkg-mcp-panel"
    data-settings-item="mcp.install"
    aria-label={mcpText("install.aria", { target: targetLabel })}
    onSubmit={(event) => {
      event.preventDefault();
      if (mode !== "import" && canSaveManual) void submitManual();
    }}
  >
    <div className="pkg-mcp-panel-head">
      <h3>{mcpText("install.title")}</h3>
      <p>{richText("install.into", { target: <strong>{targetLabel}</strong> })}</p>
    </div>
    <Seg
      value={mode}
      options={personal
        ? [["http", mcpText("transport.http")], ["stdio", mcpText("transport.stdio")]]
        : [["http", mcpText("transport.http")], ["stdio", mcpText("transport.stdio")], ["import", mcpText("transport.import")]]}
      onChange={(next) => {
        setMode(next);
        setSecretRows(emptySecrets());
        setError("");
        setPreviewed(false);
      }}
    />
    {mode !== "import" ? <>
      <Field label={mcpText("field.name")} hint={mcpText("field.nameHint")}>
        <TextInput
          uiSize="sm"
          value={name}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="docs"
          onChange={(event) => setName(event.target.value)}
          aria-label={mcpText("field.nameAria")}
        />
      </Field>
      <TransportFields
        kind={mode}
        url={url}
        command={command}
        argsText={argsText}
        argsError={parsedArgs.error}
        onUrl={setUrl}
        onCommand={setCommand}
        onArgs={setArgsText}
      />
      <McpSecretFields kind={mode} rows={secretRows} onChange={setSecretRows} />
    </> : <div className="pkg-mcp-import" data-settings-item="mcp.import">
      <p className="pkg-mcp-help">
        {richText("import.help", {
          standard: <code>mcpServers</code>,
          codex: <code>mcp_servers</code>,
          opencode: <code>mcp</code>,
        })}
      </p>
      <Textarea
        rows={7}
        className="mono"
        aria-label={mcpText("import.jsonAria")}
        spellCheck={false}
        placeholder='{"mcpServers":{"example":{"command":"npx","args":["-y","server"]}}}'
        value={importText}
        onChange={(event) => {
          setImportText(event.target.value);
          setPreviewed(false);
          setError("");
        }}
      />
      {previewed && parsedImport && <ul className="pkg-mcp-preview" aria-live="polite" aria-label={mcpText("import.previewAria")}>
        {importPreview.map((entry) => (
          <li key={entry.name} className="pkg-mcp-preview-row" data-issue={entry.issue ? "true" : undefined}>
            <Icon icon={entry.kind === "http" ? GlobeIcon : TerminalIcon} size="sm" />
            <span className="pkg-mcp-preview-text">
              <strong>{entry.name}</strong>
              <span className="pkg-mcp-preview-summary">{entry.summary}</span>
              {entry.secretKeys.length > 0 && <span className="pkg-mcp-secret-keys">{mcpText("import.secrets", { keys: entry.secretKeys.join(", ") })}</span>}
              {entry.enabled === false && <span className="pkg-mcp-secret-keys">{mcpText("import.disabled")}</span>}
              {entry.issue && <span className="pkg-mcp-preview-issue">{entry.issue}</span>}
            </span>
          </li>
        ))}
        {importErrors.map((message) => <li key={message} className="form-error">{message}</li>)}
      </ul>}
    </div>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="pkg-mcp-panel-actions">
      <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={finish}>{mcpText("action.cancel")}</Button>
      {mode === "import" ? <>
        <Button size="sm" type="button" disabled={busy || !importText.trim()} onClick={() => setPreviewed(true)}>{mcpText("action.preview")}</Button>
        <Button
          size="sm"
          variant="primary"
          type="button"
          busy={busy}
          disabled={!previewed || !parsedImport || parsedImport.entries.length === 0 || importErrors.length > 0}
          onClick={() => void submitImport()}
        >
          {busy ? mcpText("action.importing") : mcpText("action.import", { count: parsedImport?.entries.length ?? 0 })}
        </Button>
      </> : <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!canSaveManual}>
        {mcpText("action.addServer")}
      </Button>}
    </div>
  </form>;
}

function McpToolsPanel({
  server,
  inspection,
  loading,
  error,
  query,
  onQuery,
}: {
  server: McpInstallationDto;
  inspection?: McpInspectionDto;
  loading: boolean;
  error: string;
  query: string;
  onQuery: (value: string) => void;
}) {
  const status = inspectionStatus(server);
  const checked = formatCheckedAt(inspection?.checkedAt ?? 0);
  const tools = inspection?.tools ?? [];
  const visible = filterTools(tools, query);
  return <div className="pkg-mcp-tools" data-settings-item="mcp.tools">
    <div className="pkg-mcp-tools-head">
      <Badge tone={statusTone(status)} dot>{mcpText(`status.${status}`)}</Badge>
      <span className="pkg-mcp-server-hint">
        {loading ? mcpText("tools.checking") : mcpText("tools.count", { count: tools.length })}
        {checked ? ` · ${mcpText("tools.lastCheck", { time: checked })}` : ""}
        {inspection?.serverInfo ? ` · ${inspection.serverInfo.name} ${inspection.serverInfo.version}` : ""}
      </span>
    </div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {status === "unchecked" && !loading && <p className="pkg-mcp-help">{mcpText("tools.notChecked")}</p>}
    {inspection && !inspection.ok && inspection.checkedAt > 0 && <p className="pkg-mcp-help">{inspection.message}</p>}
    {tools.length > 0 && <TextInput
      uiSize="sm"
      type="search"
      value={query}
      placeholder={mcpText("tools.searchPlaceholder", { count: tools.length })}
      aria-label={mcpText("tools.searchAria")}
      onChange={(event) => onQuery(event.target.value)}
    />}
    {!loading && inspection && inspection.ok && tools.length === 0 && (
      <EmptyState title={mcpText("tools.emptyTitle")} body={mcpText("tools.emptyBody")} />
    )}
    {!loading && query.trim() && visible.length === 0 && tools.length > 0 && (
      <EmptyState title={mcpText("tools.noMatchTitle")} body={mcpText("tools.noMatchBody", { query: query.trim() })} />
    )}
    {visible.length > 0 && <ul className="pkg-mcp-tool-list">
      {visible.map((tool) => <McpToolDetails key={tool.name} tool={tool} />)}
    </ul>}
  </div>;
}

function McpToolDetails({ tool }: { tool: McpToolDto }) {
  const [open, setOpen] = useState(false);
  return <li className="pkg-mcp-tool" data-open={open ? "true" : undefined}>
    <Button
      size="sm"
      variant="ghost"
      className="pkg-mcp-tool-toggle"
      aria-expanded={open}
      title={open ? mcpText("tools.hideSchema") : mcpText("tools.showSchema")}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="pkg-mcp-tool-name">{tool.name}</span>
    </Button>
    {tool.description && <p className="pkg-mcp-help pkg-mcp-tool-desc">{tool.description}</p>}
    {open && <pre className="pkg-mcp-schema">{JSON.stringify(tool.inputSchema, null, 2)}</pre>}
  </li>;
}

export default function McpPage() {
  useLocaleRefresh();
  const activeProjectId = useStore((state) => state.activeProjectId);
  const projectRegistry = useStore((state) => state.projectRegistry);
  const projects = projectRegistry.projects;
  const activeProject = projects.find((candidate) => candidate.id === activeProjectId);
  const projectSpaces = new Set(projects.map((project) => project.spaceId ?? "default"));
  const spaceId = activeProject
    ? activeProject.spaceId ?? "default"
    : projectSpaces.size === 1 ? projects[0]!.spaceId ?? "default" : undefined;
  const scopeResolved = projectRegistry.status === "ready" && (spaceId !== undefined || projects.length === 0);
  const spaceProjects = useMemo(
    () => spaceId ? projects.filter((project) => (project.spaceId ?? "default") === spaceId) : [],
    [projects, spaceId],
  );

  const [scope, setScope] = useState<McpScope>("project");
  const [access, setAccess] = useState<McpAccessDto | null>(null);
  const personal = scope === "person";
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(activeProjectId);
  const [servers, setServers] = useState<McpInstallationDto[]>([]);
  // Project view also reads the Global list so a project entry that shadows a
  // Global server by name can say so; the server only returns the effective set.
  const [globalServers, setGlobalServers] = useState<McpInstallationDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [installMode, setInstallMode] = useState<InstallMode>("http");
  const [serverQuery, setServerQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const [toolsLoadingId, setToolsLoadingId] = useState<string | null>(null);
  const [toolsError, setToolsError] = useState<Record<string, string>>({});
  const [busyRows, setBusyRows] = useState<Record<string, RowBusy>>({});
  const busyRowsRef = useRef<Record<string, RowBusy>>({});
  const [native, setNative] = useState<HarnessCapabilityStatusDto[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Resolve membership during render: an effect-only correction could issue a
  // request with the previous Space's project before the effect ran.
  const selectedProject = spaceProjects.find((project) => project.id === selectedProjectId)
    ?? spaceProjects.find((project) => project.id === activeProjectId)
    ?? spaceProjects[0];
  const resolvedProjectId = selectedProject?.id ?? null;
  useEffect(() => {
    setSelectedProjectId(resolvedProjectId);
  }, [resolvedProjectId]);

  const projectId = scope === "project" ? selectedProject?.id : undefined;
  const selection = JSON.stringify([projectRegistry.status, spaceId ?? null, scope, projectId ?? null]);
  // Who may write what in this Space; the server enforces it either way.
  useEffect(() => {
    if (!scopeResolved) return;
    const controller = new AbortController();
    setAccess(null);
    void api.get<McpAccessDto>("/api/mcp/access", { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) setAccess(next); })
      .catch(() => { if (!controller.signal.aborted) setAccess(LEGACY_ACCESS); });
    return () => controller.abort();
  }, [scopeResolved, spaceId]);
  useEffect(() => {
    if (access && !access.canManagePersonal && scope === "person") setScope("space");
  }, [access, scope]);
  const visitRef = useRef({ selection, generation: 0 });
  if (visitRef.current.selection !== selection) {
    visitRef.current = { selection, generation: visitRef.current.generation + 1 };
  }
  // A -> B -> A is a new visit; matching project IDs do not revive old work.
  const selectionKey = `${visitRef.current.generation}:${selection}`;
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const projectLabel = selectedProject?.name || selectedProject?.path || mcpText("scope.noneSelected");
  const scopeLabel = scope === "project"
    ? mcpText("scope.projectLabel", { project: projectLabel })
    : personal ? mcpText("scope.personalLabel") : mcpText("scope.globalLabel");

  const resetTransient = useCallback(() => {
    setAdding(false);
    setEditingId(null);
    setExpandedId(null);
    setToolQuery("");
    setToolsLoadingId(null);
    setToolsError({});
    busyRowsRef.current = {};
    setBusyRows({});
    setServers([]);
    setGlobalServers([]);
    setServerQuery("");
    setNative([]);
    setError("");
  }, []);
  useEffect(() => resetTransient(), [selectionKey, resetTransient]);

  const stillCurrent = useCallback((operationKey: string) =>
    mountedRef.current && selectionRef.current === operationKey,
  []);

  const refreshRequestRef = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const operationKey = selectionKey;
    const requestId = ++refreshRequestRef.current;
    if (!scopeResolved || (scope === "project" && !projectId)) {
      if (!signal?.aborted && stillCurrent(operationKey)) {
        setServers([]);
        setGlobalServers([]);
      }
      return;
    }
    const current = () => !signal?.aborted && stillCurrent(operationKey) && refreshRequestRef.current === requestId;
    const init = signal ? { signal } : undefined;
    try {
      const [rows, globalRows] = await Promise.all([
        api.get<McpInstallationDto[]>(serversPath(personal, projectId), init),
        // Shadow detection is decoration: its failure must not block the list.
        projectId
          ? api.get<McpInstallationDto[]>("/api/mcp/servers", init).catch(() => [] as McpInstallationDto[])
          : Promise.resolve(undefined),
      ]);
      if (current()) {
        setServers(rows);
        setGlobalServers(globalRows ?? rows);
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [scopeResolved, scope, personal, projectId, selectionKey, stillCurrent]);

  useEffect(() => {
    const controller = new AbortController();
    const operationKey = selectionKey;
    setLoading(true);
    setError("");
    void refresh(controller.signal).finally(() => {
      if (!controller.signal.aborted && stillCurrent(operationKey)) setLoading(false);
    });
    return () => controller.abort();
  }, [refresh, selectionKey, stillCurrent]);

  useEffect(() => {
    if (!scopeResolved || (!projectId && scope === "project")) {
      setNative([]);
      return;
    }
    const controller = new AbortController();
    const operationKey = selectionKey;
    void api.get<HarnessCapabilityStatusDto[]>(
      `/api/harnesses/capabilities${queryFor(projectId)}`,
      { signal: controller.signal },
    ).then((rows) => {
      if (stillCurrent(operationKey) && !controller.signal.aborted) setNative(rows);
    }).catch(() => {
      if (stillCurrent(operationKey) && !controller.signal.aborted) setNative([]);
    });
    return () => controller.abort();
  }, [scopeResolved, projectId, scope, selectionKey, stillCurrent]);

  const ownsSelectedScope = useCallback((server: McpInstallationDto): boolean =>
    server.scope === scope
    && (scope === "project" ? server.projectId === projectId : server.projectId === undefined),
  [scope, projectId]);

  const markBusy = (id: string, action: RowBusy): boolean => {
    if (busyRowsRef.current[id]) return false;
    busyRowsRef.current = { ...busyRowsRef.current, [id]: action };
    setBusyRows(busyRowsRef.current);
    return true;
  };
  const clearBusy = (id: string) => {
    const next = { ...busyRowsRef.current };
    delete next[id];
    busyRowsRef.current = next;
    setBusyRows(next);
  };

  const loadCachedTools = async (server: McpInstallationDto) => {
    if (server.inspection || busyRowsRef.current[server.id]) {
      setExpandedId(server.id);
      return;
    }
    if (!markBusy(server.id, "tools")) return;
    const operationKey = selectionKey;
    setToolsLoadingId(server.id);
    setToolsError((current) => ({ ...current, [server.id]: "" }));
    try {
      const cached = await api.get<McpInspectionDto>(
        serversPath(personal, projectId, `/${encodeURIComponent(server.id)}/tools`),
      );
      if (!stillCurrent(operationKey)) return;
      setServers((rows) => rows.map((row) => row.id === server.id ? { ...row, inspection: cached } : row));
      setExpandedId(server.id);
    } catch (cause) {
      if (stillCurrent(operationKey)) {
        setToolsError((current) => ({
          ...current,
          [server.id]: cause instanceof Error ? cause.message : String(cause),
        }));
        setExpandedId(server.id);
      }
    } finally {
      if (stillCurrent(operationKey)) {
        setToolsLoadingId((current) => current === server.id ? null : current);
        clearBusy(server.id);
      }
    }
  };

  const probe = async (server: McpInstallationDto) => {
    if (!markBusy(server.id, "probe")) return;
    const operationKey = selectionKey;
    setToolsError((current) => ({ ...current, [server.id]: "" }));
    setExpandedId(server.id);
    setToolsLoadingId(server.id);
    try {
      const result = await api.post<McpInspectionDto>(
        serversPath(personal, projectId, `/${encodeURIComponent(server.id)}/probe`),
        {},
      );
      if (!stillCurrent(operationKey)) return;
      setServers((rows) => rows.map((row) => row.id === server.id
        ? {
          ...row,
          inspection: result,
          status: !row.enabled ? "disabled" : result.ok ? "connected" : "error",
          ...(result.ok ? {} : { lastError: result.message }),
        }
        : row));
      await refresh();
    } catch (cause) {
      if (stillCurrent(operationKey)) {
        setToolsError((current) => ({
          ...current,
          [server.id]: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    } finally {
      if (stillCurrent(operationKey)) {
        setToolsLoadingId((current) => current === server.id ? null : current);
        clearBusy(server.id);
      }
    }
  };

  const toggle = async (server: McpInstallationDto) => {
    if (!ownsSelectedScope(server) || !markBusy(server.id, "toggle")) return;
    const operationKey = selectionKey;
    setError("");
    try {
      await api.patch<McpInstallationDto>(
        serversPath(personal, projectId, `/${encodeURIComponent(server.id)}`),
        { enabled: !server.enabled, expectedRevision: server.revision },
      );
      if (stillCurrent(operationKey)) await refresh();
    } catch (cause) {
      if (stillCurrent(operationKey)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (stillCurrent(operationKey)) clearBusy(server.id);
    }
  };

  const override = async (server: McpInstallationDto, enabled: boolean, edit = false) => {
    if (scope !== "project" || !projectId || !markBusy(server.id, "override")) return;
    const operationKey = selectionKey;
    setError("");
    try {
      const created = await api.post<McpInstallationDto>(
        `/api/mcp/servers/${encodeURIComponent(server.id)}/override${queryFor(projectId)}`,
        { enabled },
      );
      if (stillCurrent(operationKey)) {
        await refresh();
        // Customize lands straight in the editor for the new project copy.
        if (edit && created?.id && stillCurrent(operationKey)) setEditingId(created.id);
      }
    } catch (cause) {
      if (stillCurrent(operationKey)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (stillCurrent(operationKey)) clearBusy(server.id);
    }
  };

  const remove = async (server: McpInstallationDto) => {
    const operationKey = selectionKey;
    if (!ownsSelectedScope(server) || busyRowsRef.current[server.id]) return;
    const message = scope === "project"
      ? mcpText("remove.confirmProject", { name: server.name, project: selectedProject?.name ?? projectId ?? "" })
      : mcpText(personal ? "remove.confirmPersonal" : "remove.confirmSpace", { name: server.name });
    if (!await confirmAlert(message, {
      title: mcpText("remove.title"),
      confirmLabel: mcpText("remove.confirm"),
    })) return;
    if (!stillCurrent(operationKey) || !markBusy(server.id, "remove")) return;
    setError("");
    try {
      await api.delete<{ ok: boolean }>(
        serversPath(personal, projectId, `/${encodeURIComponent(server.id)}`),
      );
      if (stillCurrent(operationKey)) await refresh();
    } catch (cause) {
      if (stillCurrent(operationKey)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (stillCurrent(operationKey)) clearBusy(server.id);
    }
  };

  const existingNames = useMemo(() => new Set(servers.map((server) => server.name)), [servers]);
  const nativeRows = useMemo(() => nativeMcpStatuses(native), [native]);
  const nativeGroups = useMemo(() => {
    const groups: Array<{ harnessId: string; rows: typeof nativeRows }> = [];
    for (const row of nativeRows) {
      const group = groups.find((candidate) => candidate.harnessId === row.harnessId);
      if (group) group.rows.push(row);
      else groups.push({ harnessId: row.harnessId, rows: [row] });
    }
    return groups;
  }, [nativeRows]);
  const canManage = scopeResolved && (scope !== "project" || !!projectId);
  // Space and project servers change only for Space admins; members read them.
  const canWrite = canManage && !!access && (personal ? access.canManagePersonal : access.canManageSpace);
  const globalRows = useMemo(() => globalServers.filter((server) => server.scope === "space"), [globalServers]);
  const globalNames = useMemo(() => new Set(globalRows.map((server) => server.name)), [globalRows]);
  const needle = serverQuery.trim().toLowerCase();
  const visibleServers = needle
    ? servers.filter((server) => server.name.toLowerCase().includes(needle)
      || describeTransport(server.transport).toLowerCase().includes(needle))
    : servers;
  const ownRows = visibleServers.filter(ownsSelectedScope);
  const inheritedRows = scope === "project" ? visibleServers.filter((server) => server.scope === "space") : [];
  const statusCounts = servers.reduce((counts, server) => {
    const label = inspectionStatus(server);
    if (server.enabled) counts.enabled++;
    if (label === "failed") counts.failed++;
    if (label === "unchecked") counts.unchecked++;
    return counts;
  }, { enabled: 0, failed: 0, unchecked: 0 });
  const projectCount = scope === "project" ? servers.filter((server) => server.scope === "project").length : undefined;
  const showList = canManage && !loading && servers.length > 0;

  const openInstall = (mode: InstallMode) => {
    setInstallMode(mode);
    setEditingId(null);
    setAdding(true);
  };

  const renderServer = (server: McpInstallationDto) => {
    const editable = ownsSelectedScope(server) && canWrite && server.canManage !== false;
    const inherited = scope === "project" && server.scope === "space";
    const checkable = server.canManage !== false && canWrite;
    const overridesGlobal = scope === "project" && server.scope === "project" && globalNames.has(server.name);
    if (editingId === server.id && editable) {
      return <li key={`${selectionKey}:${server.id}`} className="pkg-mcp-server-edit">
        <McpServerForm
          existing={server}
          projectId={projectId}
          personal={personal}
          selectionKey={selectionKey}
          selectionRef={selectionRef}
          onDone={() => { setEditingId(null); void refresh(); }}
        />
      </li>;
    }
    const rowBusy = busyRows[server.id];
    const status = inspectionStatus(server);
    const keys = secretKeys(server.transport);
    const toolCount = server.inspection?.tools.length ?? 0;
    const expanded = expandedId === server.id;
    const origin = inherited ? mcpText("origin.inherited") : server.scope === "project" ? mcpText("origin.project") : server.scope === "person" ? mcpText("origin.person") : mcpText("origin.global");
    return <li
      key={server.id}
      className="pkg-mcp-server"
      data-mcp-server={server.id}
      data-enabled={server.enabled ? "true" : "false"}
      data-expanded={expanded ? "true" : undefined}
    >
      <div className="pkg-mcp-server-main">
        <span className="pkg-mcp-server-icon" data-kind={server.transport.kind} aria-hidden="true">
          <Icon icon={server.transport.kind === "http" ? GlobeIcon : TerminalIcon} size="md" />
        </span>
        <div className="pkg-mcp-server-text">
          <div className="pkg-mcp-server-title">
            <span className="pkg-mcp-server-name">{server.name}</span>
            <span className="pkg-mcp-status" title={statusHint(status)}>
              <Badge tone={statusTone(status)} dot>{mcpText(`status.${status}`)}</Badge>
            </span>
            {overridesGlobal && <Badge tone="accent">{mcpText("origin.overridesGlobal")}</Badge>}
          </div>
          <div className="pkg-mcp-server-meta" title={describeTransport(server.transport)}>
            {describeTransport(server.transport)}
          </div>
          <div className="pkg-mcp-server-hint">
            <span>{origin}</span>
            <span>{server.transport.kind === "http" ? "HTTP" : mcpText("transport.stdio")}</span>
            {toolCount > 0 && <span>{mcpText("tools.count", { count: toolCount })}</span>}
          </div>
          {keys.length > 0 && <div className="pkg-mcp-secret-keys">
            <Icon icon={KeyIcon} size="sm" />
            {mcpText(server.transport.kind === "stdio" ? "secrets.envList" : "secrets.headerList", { keys: keys.join(", ") })}
          </div>}
        </div>
        {(editable || (inherited && canWrite)) && <Switch
          className="pkg-mcp-server-switch"
          checked={server.enabled}
          disabled={!!rowBusy}
          label={inherited
            ? mcpText(server.enabled ? "server.turnOffForProject" : "server.turnOnForProject", { name: server.name })
            : mcpText(server.enabled ? "server.disable" : "server.enable", { name: server.name })}
          onChange={(next) => void (inherited ? override(server, next) : toggle(server))}
        />}
      </div>
      <div className="pkg-mcp-server-actions">
        {checkable && <Button
          size="sm"
          data-settings-item="mcp.check"
          busy={rowBusy === "probe"}
          disabled={!!rowBusy}
          title={mcpText("server.checkTools")}
          onClick={() => void probe(server)}
        >{mcpText("server.checkTools")}</Button>}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          busy={toolsLoadingId === server.id}
          disabled={!!rowBusy && rowBusy !== "probe"}
          onClick={() => {
            if (expanded) {
              setExpandedId(null);
              return;
            }
            setToolQuery("");
            void loadCachedTools(server);
          }}
        >{expanded ? mcpText("server.hideTools") : mcpText("server.showTools")}</Button>
        <span className="pkg-mcp-actions-spacer" />
        {inherited && canWrite && <Button
          size="sm"
          variant="ghost"
          iconStart={EditIcon}
          busy={rowBusy === "override"}
          disabled={!!rowBusy}
          title={mcpText("server.customizeHint")}
          onClick={() => void override(server, true, true)}
        >{mcpText("server.customize")}</Button>}
        {editable && <IconButton
          icon={EditIcon}
          size="sm"
          variant="ghost"
          label={mcpText("form.edit", { name: server.name })}
          disabled={!!rowBusy}
          onClick={() => { setAdding(false); setEditingId(server.id); }}
        />}
        {editable && <IconButton
          icon={DeleteIcon}
          size="sm"
          variant="danger"
          label={mcpText("server.remove", { name: server.name })}
          busy={rowBusy === "remove"}
          disabled={!!rowBusy}
          onClick={() => void remove(server)}
        />}
      </div>
      {expanded && <McpToolsPanel
        server={server}
        inspection={server.inspection}
        loading={toolsLoadingId === server.id}
        error={toolsError[server.id] ?? ""}
        query={toolQuery}
        onQuery={setToolQuery}
      />}
    </li>;
  };

  const scopeOptions: McpScope[] = access?.canManagePersonal ? ["space", "project", "person"] : ["space", "project"];
  const scopeOption = (value: McpScope) => {
    const selected = scope === value;
    const isProject = value === "project";
    const isPerson = value === "person";
    const count = isProject ? projectCount : isPerson ? (personal ? servers.length : undefined) : globalRows.length;
    const showCount = scopeResolved && !loading && count !== undefined && (isProject ? scope === "project" : true);
    return <button
      key={value}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className="pkg-mcp-scope-option"
      data-mcp-scope={value}
      onClick={() => setScope(value)}
    >
      <span className="pkg-mcp-scope-icon" aria-hidden="true">
        <Icon icon={isProject ? FolderIcon : isPerson ? LockIcon : LayersIcon} size="md" />
      </span>
      <span className="pkg-mcp-scope-text">
        <span className="pkg-mcp-scope-title">
          {isProject ? mcpText("scope.project") : isPerson ? mcpText("scope.person") : mcpText("scope.global")}
          {showCount && <span className="pkg-mcp-scope-count">{count}</span>}
        </span>
        <span className="pkg-mcp-scope-detail">
          {isProject ? mcpText("scope.projectDetail") : isPerson ? mcpText("scope.personDetail") : mcpText("scope.globalDetail")}
        </span>
      </span>
    </button>;
  };

  return <div className="pkg-mcp">
    <PageHead
      title="MCP"
      blurb={mcpText("page.blurb")}
    />
    <section className="pkg-mcp-hero" aria-label={mcpText("page.heroAria")}>
      <div
        className="pkg-mcp-scope"
        data-options={scopeOptions.length}
        role="radiogroup"
        aria-label={mcpText("page.scopeAria")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
          const index = scopeOptions.indexOf(scope);
          const next = scopeOptions[(index + step + scopeOptions.length) % scopeOptions.length]!;
          setScope(next);
          event.currentTarget.querySelector<HTMLElement>(`[data-mcp-scope="${next}"]`)?.focus();
        }}
      >
        {scopeOptions.map(scopeOption)}
      </div>
      {scope === "project" && <div className="pkg-mcp-project">
        <ProjectPicker
          label={mcpText("scope.project")}
          ariaLabel={mcpText("page.projectAria")}
          projects={spaceProjects}
          value={resolvedProjectId}
          onPick={setSelectedProjectId}
          disabled={projectRegistry.status !== "ready"}
          placeholder={mcpText("page.selectProject")}
          emptyMessage={mcpText("page.noProjects")}
        />
        <p className="pkg-mcp-help">
          {mcpText("page.projectHelp")}
        </p>
      </div>}
      {scope === "space" && <p className="pkg-mcp-help">
        {mcpText("page.spaceHelp")}
      </p>}
      {personal && <p className="pkg-mcp-help">
        {mcpText("page.personHelp")}
      </p>}
      {!personal && access && !access.canManageSpace && <p className="pkg-mcp-help" data-mcp-readonly="true">
        {mcpText("page.readonlyHelp")}
      </p>}
    </section>

    {canManage && <div className="pkg-mcp-toolbar">
      <div className="pkg-mcp-stats" aria-live="polite">
        {loading ? mcpText("page.loading") : <>
          <span>{richText("stats.servers", { count: <strong>{servers.length}</strong> })}</span>
          {servers.length > 0 && <span>{richText("stats.enabled", { count: <strong>{statusCounts.enabled}</strong> })}</span>}
          {statusCounts.failed > 0 && <span className="pkg-mcp-stat-danger">{richText("stats.failed", { count: <strong>{statusCounts.failed}</strong> })}</span>}
          {statusCounts.unchecked > 0 && <span>{richText("stats.unchecked", { count: <strong>{statusCounts.unchecked}</strong> })}</span>}
        </>}
      </div>
      {servers.length > SERVER_FILTER_THRESHOLD && <div className="pkg-mcp-filter">
        <Icon icon={SearchIcon} size="sm" />
        <TextInput
          uiSize="sm"
          type="search"
          value={serverQuery}
          placeholder={mcpText("filter.placeholder")}
          aria-label={mcpText("filter.aria")}
          onChange={(event) => setServerQuery(event.target.value)}
        />
      </div>}
      {!adding && canWrite && <Button size="sm" variant="primary" iconStart={PlusIcon} onClick={() => openInstall("http")}>
        {mcpText("install.title")}
      </Button>}
    </div>}

    {error && <div className="form-error" role="alert">{error}</div>}

    {adding && canWrite && <McpInstallPanel
      key={selectionKey}
      projectId={projectId}
      personal={personal}
      targetLabel={scopeLabel}
      initialMode={installMode}
      existingNames={existingNames}
      selectionKey={selectionKey}
      selectionRef={selectionRef}
      onDone={() => { setAdding(false); void refresh(); }}
    />}

    {projectRegistry.status !== "ready"
      ? <EmptyState
          title={projectRegistry.status === "loading" ? mcpText("empty.loadingProjects") : mcpText("empty.projectsFailed")}
          busy={projectRegistry.status === "loading"}
          body={projectRegistry.status === "failed" ? projectRegistry.error : undefined}
        />
      : !scopeResolved
        ? <EmptyState title={mcpText("empty.selectWorkspaceTitle")} body={mcpText("empty.selectWorkspaceBody")} />
        : scope === "project" && !projectId
          ? <EmptyState title={mcpText("empty.noProjectTitle")} body={mcpText("empty.noProjectBody")} />
          : loading
            ? <EmptyState title={mcpText("empty.loadingServers")} busy />
            : servers.length === 0 && !adding
              ? <div className="pkg-mcp-empty">
                  <EmptyState
                    title={scope === "project" ? mcpText("empty.noneProject") : personal ? mcpText("empty.nonePerson") : mcpText("empty.noneGlobal")}
                    body={scope === "project"
                      ? mcpText("empty.noneProjectBody")
                      : personal
                        ? mcpText("empty.nonePersonBody")
                        : mcpText("empty.noneGlobalBody")}
                  />
                  {canWrite && <div className="pkg-mcp-quickstart">
                    <Button size="sm" iconStart={GlobeIcon} onClick={() => openInstall("http")}>{mcpText("quick.http")}</Button>
                    <Button size="sm" iconStart={TerminalIcon} onClick={() => openInstall("stdio")}>{mcpText("quick.stdio")}</Button>
                    {!personal && <Button size="sm" iconStart={UploadIcon} onClick={() => openInstall("import")}>{mcpText("quick.import")}</Button>}
                  </div>}
                </div>
              : null}

    {showList && <div className="pkg-mcp-sections" data-settings-item="mcp.servers">
      <Section
        title={scope === "project" ? mcpText("section.project") : personal ? mcpText("section.person") : mcpText("section.space")}
        hint={scope === "project"
          ? mcpText("section.projectHint", { project: projectLabel })
          : personal ? mcpText("section.personHint") : mcpText("section.spaceHint")}
      >
        {ownRows.length > 0
          ? <ul className="pkg-mcp-list">{ownRows.map(renderServer)}</ul>
          : needle
            ? <p className="pkg-mcp-help">{mcpText("filter.noMatch", { query: serverQuery.trim() })}</p>
            : <EmptyState
                compact
                icon="server"
                title={mcpText("empty.noProjectServersTitle")}
                body={mcpText("empty.noProjectServersBody")}
                {...(adding || !canWrite ? {} : { action: { label: mcpText("install.title"), onClick: () => openInstall("http") } })}
              />}
      </Section>
      {inheritedRows.length > 0 && <Section
        title={mcpText("origin.inherited")}
        hint={mcpText("section.inheritedHint")}
      >
        <ul className="pkg-mcp-list">{inheritedRows.map(renderServer)}</ul>
      </Section>}
      {needle && ownRows.length === 0 && inheritedRows.length === 0 && scope === "project" && (
        <p className="pkg-mcp-help">{mcpText("filter.noMatch", { query: serverQuery.trim() })}</p>
      )}
    </div>}

    {nativeRows.length > 0 && <Section
      title={mcpText("native.title")}
      itemId="mcp.native"
      hint={mcpText("native.hint")}
    >
      <ul className="pkg-mcp-native-list">
        {nativeGroups.map((group) => (
          <li key={group.harnessId} className="pkg-mcp-native-row">
            <span className="pkg-mcp-native-name">{harnessDisplayName(group.harnessId)}</span>
            <span className="pkg-mcp-native-states">
              {group.rows.map((row) => (
                <span key={row.status} className="pkg-mcp-native-state" data-status={row.status}>
                  <Badge tone={nativeTone(row.status)} dot>{nativeStatusLabel(row.status)}</Badge>
                  <span>
                    {mcpText("native.row", { count: row.count, label: row.label })}
                    {row.reason ? <span className="pkg-mcp-native-reason"> — {row.reason}</span> : null}
                  </span>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Section>}

    {canManage && <p className="pkg-mcp-footnote">
      {mcpText("page.footnote")}
    </p>}
  </div>;
}
