import {
  parseWebSearchSettings,
  WEB_SEARCH_SETTINGS_VERSION,
  type WebSearchProviderId,
  type WebSearchSettings,
} from "./settings.ts";

export interface WebSearchCredentialHandleOption {
  handle: string;
  label: string;
  kind: "env" | "token";
  purpose?: string;
}

export interface WebSearchProviderStatus {
  id: WebSearchProviderId;
  name: string;
  available: boolean;
  requiresCredential: boolean;
  configured: boolean;
}

export interface WebSearchSettingsSnapshot {
  version: typeof WEB_SEARCH_SETTINGS_VERSION;
  revision: number;
  settings: WebSearchSettings;
  providers: WebSearchProviderStatus[];
  credentialHandles: WebSearchCredentialHandleOption[];
  vaultAvailable: boolean;
}

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("web search settings response must be an object");
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string") return invalid(`${label} must be a string`);
  if (!value.trim()) return invalid(`${label} must be a non-empty string`);
  return value;
};

export function parseWebSearchSettingsSnapshot(value: unknown): WebSearchSettingsSnapshot {
  const input = object(value);
  if (input.version !== WEB_SEARCH_SETTINGS_VERSION) invalid("unsupported web search settings version");
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) invalid("revision must be a non-negative integer");
  const providerRows = input.providers;
  const handleRows = input.credentialHandles;
  const vaultAvailable = input.vaultAvailable;
  if (!Array.isArray(providerRows)) return invalid("providers must be an array");
  if (!Array.isArray(handleRows)) return invalid("credentialHandles must be an array");
  if (typeof vaultAvailable !== "boolean") return invalid("vaultAvailable must be a boolean");

  const providers: WebSearchProviderStatus[] = (providerRows as unknown[]).map((value: unknown, index: number) => {
    const provider = object(value);
    const id = string(provider.id, `providers[${index}].id`);
    if (id !== "duckduckgo" && id !== "tavily") invalid(`providers[${index}].id is unsupported`);
    const available = provider.available;
    const requiresCredential = provider.requiresCredential;
    const configured = provider.configured;
    if (typeof available !== "boolean" || typeof requiresCredential !== "boolean" || typeof configured !== "boolean") {
      invalid(`providers[${index}] availability flags must be booleans`);
    }
    return {
      id: id as WebSearchProviderId,
      name: string(provider.name, `providers[${index}].name`),
      available: available as boolean,
      requiresCredential: requiresCredential as boolean,
      configured: configured as boolean,
    };
  });

  const credentialHandles: WebSearchCredentialHandleOption[] = (handleRows as unknown[]).map((value: unknown, index: number) => {
    const handle = object(value);
    const kind = string(handle.kind, `credentialHandles[${index}].kind`);
    if (kind !== "env" && kind !== "token") invalid(`credentialHandles[${index}].kind is unsupported`);
    const result: WebSearchCredentialHandleOption = {
      handle: string(handle.handle, `credentialHandles[${index}].handle`),
      label: string(handle.label, `credentialHandles[${index}].label`),
      kind: kind as "env" | "token",
    };
    if (handle.purpose !== undefined) result.purpose = string(handle.purpose, `credentialHandles[${index}].purpose`);
    return result;
  });

  return {
    version: WEB_SEARCH_SETTINGS_VERSION,
    revision: Number(input.revision),
    settings: parseWebSearchSettings(input.settings),
    providers,
    credentialHandles,
    vaultAvailable: vaultAvailable as boolean,
  };
}
