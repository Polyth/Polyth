import type {
  AuthCapabilityStatus,
  AuthProvenance,
  AvailableProviderDescriptor,
  NormalizedAuthMethod,
  ProviderAuthMethod,
  ProviderAuthView,
  ProviderCredentialStatus,
} from "@polyth/contracts";
import { hashCanonical } from "./canonical.ts";
import { normalizePromptField } from "./prompts.ts";

export const hashCapabilityRevision = (payload: unknown): string => hashCanonical(payload);

export const fingerprintAuthMethod = (method: Pick<ProviderAuthMethod, "type" | "label" | "prompts">): string =>
  hashCanonical({
    type: method.type,
    label: method.label,
    prompts: (method.prompts ?? []).map((prompt) => ({
      type: prompt.type,
      key: prompt.key,
      message: prompt.message,
      ...(prompt.options ? { options: prompt.options.map((option) => option.value) } : {}),
      ...(prompt.when ? { when: prompt.when } : {}),
    })),
  });

export const normalizeAuthMethod = (
  method: ProviderAuthMethod,
  providerId: string,
  provenance: AuthProvenance = "opencode-plugin",
): NormalizedAuthMethod => {
  const fingerprint = fingerprintAuthMethod(method);
  const fields = (method.prompts ?? []).flatMap((prompt) => {
    if (!prompt.key || !prompt.message) return [];
    return [normalizePromptField(prompt)];
  });
  if (method.type === "api" && !fields.some((field) => field.key === "key" || field.kind === "secret")) {
    fields.unshift({
      key: "key",
      kind: "secret",
      label: "API key",
      secret: true,
      autocomplete: "off",
    });
  }
  return {
    id: `${providerId}:${method.upstreamIndex}:${fingerprint}`,
    upstreamIndex: method.upstreamIndex,
    fingerprint,
    provenance,
    kind: method.type,
    label: method.label,
    fields,
    usable: true,
  };
};

export const envNamesPresent = (
  names: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] => (names ?? []).filter((name) => Boolean(name) && typeof env[name] === "string" && env[name] !== "");

export const resolveCredentialSource = (input: {
  connected: boolean;
  envPresent: readonly string[];
  justSaved?: boolean;
}): ProviderCredentialStatus | undefined => {
  if (input.envPresent.length) {
    return {
      source: "environment",
      verification: input.connected ? "verified" : "unverified",
      envVarNames: [...input.envPresent],
    };
  }
  if (input.justSaved && !input.connected) {
    return { source: "unknown", verification: "saved" };
  }
  if (input.connected) return { source: "unknown", verification: "verified" };
  return undefined;
};

export const discoveryStatus = (
  loaded: boolean,
  failed: boolean,
  unavailable: boolean,
  methodCount: number,
): AuthCapabilityStatus => {
  if (unavailable) return "unavailable";
  if (failed) return "failed";
  if (!loaded) return "failed";
  return methodCount === 0 ? "empty" : "loaded";
};

export const buildProviderAuthView = (input: {
  providerId: string;
  methods: readonly ProviderAuthMethod[] | undefined;
  metadata?: AvailableProviderDescriptor;
  connected: boolean;
  discovery: ProviderAuthView["discovery"];
  env?: NodeJS.ProcessEnv;
  justSaved?: boolean;
}): ProviderAuthView => {
  const normalized = (input.methods ?? []).map((method) => normalizeAuthMethod(method, input.providerId));
  const envPresent = envNamesPresent(input.metadata?.env, input.env);
  const docs = input.metadata?.docs;
  if (docs) {
    for (const method of normalized) {
      if (!method.docsUrl) method.docsUrl = docs;
    }
  }
  const credential = resolveCredentialSource({
    connected: input.connected,
    envPresent,
    ...(input.justSaved ? { justSaved: true } : {}),
  });
  return {
    providerId: input.providerId,
    discovery: input.discovery,
    methods: normalized,
    ...(credential ? { credential } : {}),
  };
};

export const methodsToLegacyDto = (
  methods: readonly NormalizedAuthMethod[],
): Array<{ type: "oauth" | "api"; label: string; prompts?: ProviderAuthMethod["prompts"]; upstreamIndex: number }> =>
  methods.map((method) => ({
    type: method.kind,
    label: method.label,
    upstreamIndex: method.upstreamIndex,
    ...(method.fields.length
      ? {
          prompts: method.fields
            .filter((field) => field.key !== "key")
            .map((field) => ({
              type: field.kind === "select" ? "select" as const : "text" as const,
              key: field.key,
              message: field.label,
              ...(field.placeholder ? { placeholder: field.placeholder } : {}),
              ...(field.options ? { options: field.options } : {}),
              ...(field.when ? { when: field.when } : {}),
            })),
        }
      : {}),
  }));
