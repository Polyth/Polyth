import type {
  CapabilityProvisionStatus,
  HarnessCapabilityStatusDto,
  McpStatus,
  McpTransport,
} from "@polyth/contracts";
import type { McpInspectionDto, McpToolDto } from "@polyth/contracts/capability-installations";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import type { TranslationKey } from "../../../apps/web/src/i18n/index.ts";

/** Visible MCP copy lives in the harness-runtime catalog under `harnessruntime.mcp.*`. */
export const mcpText = (key: string, values?: Record<string, string | number>): string =>
  tr(`harnessruntime.mcp.${key}` as TranslationKey, values);

export const RESERVED_MCP_NAME = "polyth-agent-tools";
export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface McpImportEntry {
  name: string;
  transport: McpTransport;
  secrets?: Record<string, string>;
  enabled: boolean;
}

export interface McpImportResult {
  entries: McpImportEntry[];
  errors: string[];
}

export interface McpImportPreview {
  name: string;
  kind: "stdio" | "http";
  summary: string;
  secretKeys: string[];
  enabled: boolean;
  issue?: string;
}

export interface McpImportServerBody {
  name: string;
  transport: McpTransport;
  enabled?: boolean;
  secrets?: Record<string, string>;
}

export interface NativeMcpStatus {
  harnessId: string;
  count: number;
  status: CapabilityProvisionStatus;
  label: string;
  /** First sanitized provisioner reason for this status, when reported. */
  reason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") Object.defineProperty(out, key, { value: item, enumerable: true });
  }
  return out;
};

const isNonEmptyRecord = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length > 0;

export function validateMcpName(value: string): string | undefined {
  const name = value.trim();
  if (!MCP_NAME_PATTERN.test(name)) {
    return mcpText("error.nameInvalid");
  }
  if (name === RESERVED_MCP_NAME) return mcpText("error.nameReserved");
  return undefined;
}

export function validateStdioCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return mcpText("error.stdioNeedsCommand");
  if (/[;&|<>`$\0]/.test(trimmed)) return mcpText("error.commandNotBare");
  return undefined;
}

export function validateHttpUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return mcpText("error.urlInvalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return mcpText("error.urlProtocol");
  if (parsed.username || parsed.password || parsed.hash) return mcpText("error.urlCredentials");
  return undefined;
}

export function parseArgsJson(text: string): { args: string[]; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { args: [] };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      return { args: [], error: mcpText("error.argsNotArray") };
    }
    if (parsed.length > 256 || parsed.some((item) => item.includes("\0") || item.length > 16_384)) {
      return { args: [], error: mcpText("error.argsNotBounded") };
    }
    return { args: parsed };
  } catch {
    return { args: [], error: mcpText("error.argsInvalidJson") };
  }
}

export function formatArgsJson(args: string[]): string {
  return args.length ? JSON.stringify(args) : "";
}

export function secretKeys(transport: McpTransport): string[] {
  return transport.kind === "stdio" ? transport.envKeys : transport.headersSecretRefs;
}

export function describeTransport(transport: McpTransport): string {
  return transport.kind === "stdio"
    ? [transport.command, ...transport.args].join(" ").trim()
    : transport.url;
}

function parseOne(name: string, raw: unknown): McpImportEntry | string {
  if (!isRecord(raw)) return mcpText("import.entryNotObject", { name });
  const nameError = validateMcpName(name);
  if (nameError) return mcpText("import.prefixed", { name: name || mcpText("import.unnamed"), message: nameError });
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return mcpText("import.enabledNotBoolean", { name });
  for (const field of ["env", "environment", "headers", "http_headers"]) {
    const value = raw[field];
    if (value !== undefined && (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string"))) {
      return mcpText("import.fieldNotStringMap", { name, field });
    }
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== "string"))) {
    return mcpText("import.argsNotArray", { name });
  }
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") return mcpText("import.disabledNotBoolean", { name });
  const enabled = raw.enabled !== false && raw.disabled !== true;
  const url = typeof raw.url === "string" ? raw.url : undefined;
  if (url !== undefined || raw.type === "remote") {
    if (!url) return mcpText("import.remoteNeedsUrl", { name });
    const urlError = validateHttpUrl(url);
    if (urlError) return mcpText("import.prefixed", { name, message: urlError });
    const headers = { ...stringMap(raw.http_headers), ...stringMap(raw.headers) };
    const refs = Object.keys(headers);
    return {
      name: name.trim(),
      transport: { kind: "http", url: url.trim(), headersSecretRefs: refs },
      ...(refs.length ? { secrets: headers } : {}),
      enabled,
    };
  }
  let command = "";
  let args: string[] = [];
  if (typeof raw.command === "string") {
    command = raw.command;
    args = (raw.args as string[] | undefined) ?? [];
  } else if (Array.isArray(raw.command)) {
    if (raw.command.some((item) => typeof item !== "string")) return mcpText("import.commandNotStrings", { name });
    const parts = raw.command as string[];
    command = parts[0] ?? "";
    args = parts.slice(1);
  }
  const commandError = validateStdioCommand(command);
  if (commandError) return mcpText("import.prefixed", { name, message: commandError });
  if (parseArgsJson(JSON.stringify(args)).error) return mcpText("import.argsNotBounded", { name });
  const env = { ...stringMap(raw.env), ...stringMap(raw.environment) };
  const envKeys = Object.keys(env);
  return {
    name: name.trim(),
    transport: { kind: "stdio", command: command.trim(), args, envKeys },
    ...(envKeys.length ? { secrets: env } : {}),
    enabled,
  };
}

const importBlock = (parsed: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (isRecord(parsed.mcp) && isRecord(parsed.mcp.servers)) return parsed.mcp.servers;
  const wrappers = [parsed.mcpServers, parsed.mcp_servers, parsed.mcp];
  const filled = wrappers.find(isNonEmptyRecord);
  if (filled) return filled;
  if (wrappers.some(isRecord)) return undefined;
  return parsed;
};

/** Parse pasted JSON. Never throws; malformed entries land in `errors`. Secret values stay off the preview path. */
export function parseMcpServersJson(text: string): McpImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [], errors: [mcpText("import.notJson")] };
  }
  if (!isRecord(parsed)) return { entries: [], errors: [mcpText("import.expectedObject")] };
  const block = importBlock(parsed);
  if (!block) return { entries: [], errors: [mcpText("import.noServers")] };
  const names = Object.keys(block);
  if (names.length > 64) return { entries: [], errors: [mcpText("import.tooMany")] };
  if (names.length === 0) return { entries: [], errors: [mcpText("import.noServers")] };
  const entries: McpImportEntry[] = [];
  const errors: string[] = [];
  for (const name of names) {
    const result = parseOne(name, block[name]);
    if (typeof result === "string") errors.push(result);
    else entries.push(result);
  }
  return { entries, errors };
}

export function validateImportBatch(entries: readonly McpImportEntry[], existingNames: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const nameError = validateMcpName(entry.name);
    if (nameError) errors.push(mcpText("import.prefixed", { name: entry.name, message: nameError }));
    if (seen.has(entry.name)) errors.push(mcpText("import.duplicate", { name: entry.name }));
    else if (existingNames.has(entry.name)) errors.push(mcpText("error.nameExists", { name: entry.name }));
    seen.add(entry.name);
  }
  return errors;
}

export function sanitizeImportPreview(
  entry: McpImportEntry,
  existingNames: ReadonlySet<string>,
): McpImportPreview {
  const nameError = validateMcpName(entry.name);
  const issue = nameError
    ?? (existingNames.has(entry.name) ? mcpText("import.issueNameExists") : undefined);
  return {
    name: entry.name,
    kind: entry.transport.kind,
    summary: describeTransport(entry.transport),
    secretKeys: secretKeys(entry.transport),
    enabled: entry.enabled,
    ...(issue ? { issue } : {}),
  };
}

export function toImportRequestBody(entries: readonly McpImportEntry[]): { servers: McpImportServerBody[] } {
  return {
    servers: entries.map((entry) => ({
      name: entry.name,
      transport: entry.transport,
      ...(entry.enabled === false ? { enabled: false } : {}),
      ...(entry.secrets && Object.keys(entry.secrets).length ? { secrets: entry.secrets } : {}),
    })),
  };
}

export type InspectionStatus = "disabled" | "unchecked" | "checked" | "failed";

export function inspectionStatus(input: {
  enabled: boolean;
  status: McpStatus;
  inspection?: McpInspectionDto;
}): InspectionStatus {
  if (!input.enabled || input.status === "disabled") return "disabled";
  if (!input.inspection || input.inspection.checkedAt === 0) return "unchecked";
  if (input.inspection.ok) return "checked";
  return "failed";
}

export function inspectionStatusLabel(input: {
  enabled: boolean;
  status: McpStatus;
  inspection?: McpInspectionDto;
}): string {
  return mcpText(`status.${inspectionStatus(input)}`);
}

export function formatCheckedAt(checkedAt: number): string | undefined {
  if (!checkedAt) return undefined;
  return new Date(checkedAt).toLocaleString(getLocale());
}

export function filterTools(tools: readonly McpToolDto[], query: string): McpToolDto[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tools];
  return tools.filter((tool) =>
    tool.name.toLowerCase().includes(needle)
    || (tool.description?.toLowerCase().includes(needle) ?? false));
}

export function nativeStatusLabel(status: CapabilityProvisionStatus): string {
  if (status === "pending" || status === "pending-restart") return mcpText("native.status.waiting");
  if (status === "applied" || status === "unverifiable") return mcpText("native.status.ready");
  if (status === "failed") return mcpText("native.status.failed");
  if (status === "degraded") return mcpText("native.status.degraded");
  if (status === "unsupported") return mcpText("native.status.unsupported");
  return mcpText("native.status.unknown");
}

export function nativeTone(status: CapabilityProvisionStatus): "neutral" | "success" | "warning" | "danger" {
  if (status === "applied" || status === "unverifiable") return "success";
  if (status === "failed") return "danger";
  if (status === "degraded") return "warning";
  return "neutral";
}

export function describeNativeProvision(status: CapabilityProvisionStatus): string {
  if (status === "pending" || status === "pending-restart") return mcpText("native.describe.pending");
  if (status === "applied") return mcpText("native.describe.applied");
  if (status === "unverifiable") return mcpText("native.describe.unverifiable");
  if (status === "failed") return mcpText("native.describe.failed");
  if (status === "degraded") return mcpText("native.describe.degraded");
  if (status === "unsupported") return mcpText("native.describe.unsupported");
  return mcpText("native.describe.unknown");
}

export function nativeMcpStatuses(rows: readonly HarnessCapabilityStatusDto[]): NativeMcpStatus[] {
  const out: NativeMcpStatus[] = [];
  for (const row of rows) {
    for (const record of row.records) {
      if (record.kind !== "mcp-server") continue;
      const existing = out.find((entry) => entry.harnessId === row.harnessId && entry.status === record.status);
      const reason = record.reason?.trim();
      if (existing) {
        existing.count++;
        if (!existing.reason && reason) existing.reason = reason;
        continue;
      }
      out.push({
        harnessId: row.harnessId,
        count: 1,
        status: record.status,
        label: describeNativeProvision(record.status),
        ...(reason ? { reason } : {}),
      });
    }
  }
  return out;
}
