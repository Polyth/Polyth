import type { AgentCapabilityKind, CapabilityMutability, CapabilityProjectionMode, HarnessSnapshot, RuntimeCapabilities } from "@polyth/contracts";

export const availabilityLabel = (row: HarnessSnapshot): string => {
  if (row.stale) return "Offline · Last known";
  switch (row.availability.state) {
    case "ready": return "Ready";
    case "not-installed": return "Not installed";
    case "starting": return "Starting…";
    case "auth-required": return "Sign in required";
    case "setup-required":
    case "partially-configured": return "Setup incomplete";
    case "incompatible": return "Not supported here";
    case "offline": return "Offline";
    case "degraded": return "Degraded";
    case "unknown": return "Not verified";
  }
};

export const orderedHarnesses = (rows: HarnessSnapshot[]) => rows.toSorted((a, b) => a.policy.priority - b.policy.priority || a.identity.id.localeCompare(b.identity.id));
export const autoCandidates = (rows: HarnessSnapshot[]) => orderedHarnesses(rows).filter((row) => row.policy.enabled && row.policy.autoSelect);
// Match the prospective Auto route; cheap probes cannot promise successful native discovery.
export const resolvedAuto = (rows: HarnessSnapshot[]) => autoCandidates(rows).find((row) => row.availability.installed
  && row.availability.healthy && row.availability.authenticated !== false
  && ["ready", "unknown"].includes(row.availability.state));
export const routingLabel = (row: HarnessSnapshot, rows: HarnessSnapshot[]): string => !row.policy.enabled ? "Disabled"
  : !row.policy.autoSelect ? "Manual only" : `Auto #${autoCandidates(rows).findIndex((candidate) => candidate.identity.id === row.identity.id) + 1}`;
export const pendingLabel = (row: HarnessSnapshot): string => [
  row.configuration?.pendingChanges ? `${row.configuration.pendingChanges} change${row.configuration.pendingChanges === 1 ? "" : "s"} pending` : "",
  row.configuration?.restartRequired ? "Restart required" : "",
].filter(Boolean).join(" · ");
export const integrationLabel = (row: HarnessSnapshot): string => !row.capabilitySupport ? "Integration not verified"
  : row.capabilitySupport.targetLifetime === "physical-runtime" ? "Runtime-managed integration" : "Session-scoped integration";

const harnessDisplayLabels: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  fx: "FX",
  omp: "OMP",
  opencode: "OpenCode",
  pi: "Pi",
};

export function harnessDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  return harnessDisplayLabels[normalized.toLowerCase()]
    ?? normalized.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

const kindLabels: Record<AgentCapabilityKind, string> = { instruction: "Instructions", "mcp-server": "MCP", tool: "Polyth tools", skill: "Skills", context: "Context", extension: "Extensions" };
const modeLabels: Record<CapabilityProjectionMode, string> = { native: "Native", mcp: "via MCP", prompt: "Prompt", filesystem: "Filesystem", config: "Config", emulated: "Emulated", unsupported: "Unsupported" };
const modeDescriptions: Record<CapabilityProjectionMode, string> = {
  native: "Delivered directly through the harness API or native capability system.",
  mcp: "Polyth exposes this capability through an MCP server.",
  prompt: "Polyth includes this capability in the session prompt.",
  filesystem: "Polyth materializes this capability as files for the harness to read.",
  config: "Polyth writes this capability into harness configuration.",
  emulated: "Polyth provides an adapter implementation of this capability.",
  unsupported: "Polyth has no verified delivery path for this capability.",
};
const mutabilityLabels: Record<CapabilityMutability, string> = { immediate: "Immediate", "session-create": "New session", "requires-restart": "Runtime restart", immutable: "Not editable" };
export type CapabilityFact = { id: string; label: string; value: string; description: string; application?: string; unsupported?: boolean };

export function projectionFacts(row: HarnessSnapshot): CapabilityFact[] {
  return (Object.keys(kindLabels) as AgentCapabilityKind[]).map((kind) => {
    const support = row.capabilitySupport?.kinds[kind];
    const remoteBlocked = row.context.remote && support?.remote === false;
    const modes = remoteBlocked ? ["unsupported" as const] : support?.modes;
    const unsupported = modes?.length === 0 || modes?.every((mode) => mode === "unsupported");
    return {
      id: kind, label: kindLabels[kind],
      value: unsupported ? "Unsupported" : modes?.map((mode) => modeLabels[mode]).join(" / ") ?? "Not verified",
      unsupported,
      application: support && !unsupported ? mutabilityLabels[support.mutability] : undefined,
      description: remoteBlocked ? "This delivery path is not supported on a remote execution target."
        : [modes?.map((mode) => modeDescriptions[mode]).join(" ") ?? "No support metadata is available.",
          support && !unsupported ? `Applies: ${mutabilityLabels[support.mutability].toLowerCase()}.` : "",
          support?.configScope && !unsupported ? `Configuration scope: ${support.configScope}.` : ""].filter(Boolean).join(" "),
    };
  });
}

const featureLabels = { streaming: "Streaming", permissions: "Permissions", questions: "Questions", subagents: "Subagents", resume: "Resume", fork: "Fork", steering: "Steering", compaction: "Compaction", usage: "Usage telemetry", cost: "Cost telemetry", mcp: "Runtime MCP", title: "Session titles", contextOccupancy: "Context telemetry" } satisfies Partial<Record<keyof RuntimeCapabilities, string>>;
const supportLabel = (value: unknown): string => value === true ? "Supported" : value === false || value === "unsupported" ? "Unsupported"
  : typeof value === "string" ? value.charAt(0).toUpperCase() + value.slice(1) : "Not verified";
export const runtimeFacts = (row: HarnessSnapshot): CapabilityFact[] => (Object.keys(featureLabels) as Array<keyof typeof featureLabels>).map((id) => ({
  id, label: featureLabels[id], value: supportLabel(row.capabilities?.[id]), description: "Declared runtime support; availability can depend on the selected model and native runtime version.",
  unsupported: row.capabilities?.[id] === false || row.capabilities?.[id] === "unsupported",
}));
export const attachmentFacts = (row: HarnessSnapshot): CapabilityFact[] => (["image", "file", "pdf", "url", "audio"] as const).map((id) => ({
  id, label: { image: "Images", file: "Files", pdf: "PDF", url: "URLs", audio: "Audio" }[id], value: supportLabel(row.capabilities?.attachments?.modalities[id]),
  description: "Harness-level support. The selected model and execution target may impose additional limits.",
  unsupported: row.capabilities?.attachments?.modalities[id] === "unsupported",
}));
export function summaryFacts(row: HarnessSnapshot): CapabilityFact[] {
  return [...projectionFacts(row).filter((fact) => ["mcp-server", "tool", "skill"].includes(fact.id)).map((fact) => fact.id === "tool" ? { ...fact, label: "Tools" } : fact),
    ...runtimeFacts(row).filter((fact) => fact.id === "resume")];
}

export function configurationSections(items: Array<{ id: string; order: number; meta?: Readonly<Record<string, unknown>> }>, harnessId: string) {
  return items.filter((item) => item.meta?.harnessId === harnessId)
    .map((item) => ({ id: String(item.meta?.sectionId ?? item.id), label: String(item.meta?.label ?? item.id), order: item.order, ...(item.meta?.handlesPendingChanges === true ? { handlesPendingChanges: true } : {}) }))
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
