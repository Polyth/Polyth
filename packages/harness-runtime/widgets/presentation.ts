import type { CSSProperties } from "react";
import { englishTranslate, pluralKey, type Translate } from "./englishTranslate.ts";
import type { AgentCapabilityKind, CapabilityMutability, CapabilityProjectionMode, HarnessSnapshot, RuntimeCapabilities } from "@polyth/contracts";
import { effectiveAttachmentDelivery } from "@polyth/contracts";
import { harnessColor } from "@polyth/models/harness-color";

export { HARNESS_COLORS } from "@polyth/models/harness-color";

/** A Space-chosen harness color, applied through one scoped custom property.
 *  An account without one gets its own color instead of a shared logo badge. */
export const harnessTint = (identity: { color?: string; accountLabel?: string }): CSSProperties | undefined => {
  const color = harnessColor(identity);
  return color ? { "--pkg-harness-color": color } as CSSProperties : undefined;
};

/** The name a compact picker or list shows: a Space title plus the account's
 *  own label, unless the name already names it. */
export const harnessProfileName = (identity: { name: string; accountLabel?: string }): string => {
  const label = identity.accountLabel?.trim();
  return label && !identity.name.toLowerCase().includes(label.toLowerCase())
    ? `${identity.name} · ${label}`
    : identity.name;
};

/** A row whose readiness Settings is still checking natively. */
export type HarnessCheckState = { checking?: boolean };

/** Rows kept from an earlier answer carry `stale`. That only matters when the
 *  latest check failed; a cached ready row is ready while it revalidates. */
const lastKnown = (row: HarnessSnapshot): boolean =>
  row.stale === true && (row.availability.state === "offline" || row.availability.state === "degraded");

const availabilityKeys = {
  ready: "ready",
  "not-installed": "notInstalled",
  starting: "starting",
  "auth-required": "signInRequired",
  "setup-required": "setupIncomplete",
  "partially-configured": "setupIncomplete",
  incompatible: "notSupportedHere",
  offline: "offline",
  degraded: "degraded",
  // Installed and answering, but its sign-in could not be confirmed.
  unknown: "notVerified",
} as const;

export const availabilityLabel = (row: HarnessSnapshot, check: HarnessCheckState = {}, t: Translate = englishTranslate): string => {
  const state = row.availability.state;
  if (check.checking && (state === "unknown" || state === "starting")) return t("presentation.checking");
  const label = t(`presentation.${availabilityKeys[state]}`);
  return lastKnown(row) ? t("presentation.lastKnown", { label }) : label;
};

/** One status family per state, so color always pairs with the label. */
export type HarnessStatusTone = "success" | "warning" | "danger" | "neutral";
export const statusTone = (row: HarnessSnapshot): HarnessStatusTone => {
  switch (row.availability.state) {
    case "ready": return "success";
    case "auth-required":
    case "setup-required":
    case "partially-configured":
    case "degraded": return "warning";
    case "offline":
    case "incompatible": return "danger";
    default: return "neutral";
  }
};

/** Whether Settings should ask the harness itself: it is in use, installed
 *  and answering, but its cheap probe cannot see sign-in. */
export const needsReadinessCheck = (row: HarnessSnapshot): boolean => row.policy.enabled
  && row.availability.installed
  && row.availability.healthy
  && row.availability.authenticated !== false
  && (row.availability.state === "unknown" || row.availability.state === "starting");

/** A version token for display: `codex-cli 0.160.0` → `0.160.0`,
 *  `2026.09.15-d2fe57e` → `2026.09.15` (the build hash stays in Diagnostics). */
export function displayVersion(text: string | undefined): string | undefined {
  const value = text?.trim();
  if (!value) return undefined;
  const match = /\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/.exec(value)?.[0];
  if (!match) return value.length > 24 ? `${value.slice(0, 23)}…` : value;
  return match.replace(/-[0-9a-f]{6,}$/i, "");
}

/** What a person can do next to make a harness usable. `sign-in-again` is
 *  offered on a signed-in harness so switching or refreshing a login is one
 *  click away; it is never the primary call to action. */
export type HarnessSetupStep =
  | { kind: "install"; command: string }
  | { kind: "sign-in"; command: string }
  | { kind: "sign-in-again"; command: string }
  | { kind: "guide"; url: string }
  | { kind: "none" };
export function setupStep(row: HarnessSnapshot): HarnessSetupStep {
  if (!row.availability.installed && row.availability.state !== "unknown") {
    return row.setup?.installCommand ? { kind: "install", command: row.setup.installCommand }
      : row.setup?.setupUrl ? { kind: "guide", url: row.setup.setupUrl } : { kind: "none" };
  }
  if (row.availability.state === "auth-required" || row.availability.authenticated === false) {
    return row.setup?.signInCommand ? { kind: "sign-in", command: row.setup.signInCommand }
      : row.setup?.setupUrl ? { kind: "guide", url: row.setup.setupUrl } : { kind: "none" };
  }
  if (row.availability.installed && row.setup?.signInCommand) return { kind: "sign-in-again", command: row.setup.signInCommand };
  return { kind: "none" };
}

/** Counts behind the overview strip of the harness list. Only a state a
 *  person can act on needs attention: a harness whose sign-in simply could
 *  not be confirmed is "not verified", and one still being checked is
 *  "checking", never a warning. */
export function harnessSummary(rows: HarnessSnapshot[], options: { checking?: ReadonlySet<string>; updates?: ReadonlySet<string> } = {}) {
  let ready = 0; let attention = 0; let signIn = 0; let off = 0; let missing = 0; let checking = 0; let unverified = 0; let updates = 0;
  for (const row of rows) {
    if (options.updates?.has(row.identity.id) && row.availability.installed) updates += 1;
    const state = row.availability.state;
    if (!row.policy.enabled) off += 1;
    else if (state === "not-installed" || state === "incompatible") missing += 1;
    else if (state === "ready") ready += 1;
    else if (state === "unknown" || state === "starting") {
      if (options.checking?.has(row.identity.id)) checking += 1;
      else unverified += 1;
    }
    else {
      attention += 1;
      if (state === "auth-required") signIn += 1;
    }
  }
  return { ready, attention, signIn, off, missing, checking, unverified, updates };
}

export const orderedHarnesses = (rows: HarnessSnapshot[]) => rows.toSorted((a, b) => a.policy.priority - b.policy.priority || a.identity.id.localeCompare(b.identity.id));
export const autoCandidates = (rows: HarnessSnapshot[]) => orderedHarnesses(rows).filter((row) => row.policy.enabled && row.policy.autoSelect);
// Match the prospective Auto route; cheap probes cannot promise successful native discovery.
export const resolvedAuto = (rows: HarnessSnapshot[]) => autoCandidates(rows).find((row) => row.availability.installed
  && row.availability.healthy && row.availability.authenticated !== false
  && ["ready", "unknown"].includes(row.availability.state));
export const routingLabel = (row: HarnessSnapshot, rows: HarnessSnapshot[], t: Translate = englishTranslate): string => !row.policy.enabled ? t("presentation.routingOff")
  : !row.policy.autoSelect ? t("presentation.routingManual")
  : t("presentation.routingAutomatic", { position: autoCandidates(rows).findIndex((candidate) => candidate.identity.id === row.identity.id) + 1 });
export const pendingLabel = (row: HarnessSnapshot, t: Translate = englishTranslate): string => [
  row.configuration?.pendingChanges ? t(pluralKey("presentation.pending", row.configuration.pendingChanges), { count: row.configuration.pendingChanges }) : "",
  row.configuration?.restartRequired ? t("presentation.restartRequired") : "",
].filter(Boolean).join(" · ");
export const integrationLabel = (row: HarnessSnapshot, t: Translate = englishTranslate): string => t(!row.capabilitySupport ? "presentation.integration.unverified"
  : row.capabilitySupport.targetLifetime === "physical-runtime" ? "presentation.integration.runtime" : "presentation.integration.session");

const harnessDisplayLabels: Readonly<Record<string, string>> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  commandcode: "Command Code",
  cursor: "Cursor",
  fx: "FX",
  grok: "Grok",
  omp: "OMP",
  opencode: "OpenCode",
  pi: "Pi",
};

const titleCase = (value: string) => value.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

/** Fallback name for a harness id without a live descriptor. An account
 *  harness (`<family>-<account>`) keeps its family brand. */
export function harnessDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  const known = harnessDisplayLabels[normalized.toLowerCase()];
  if (known) return known;
  const account = /^([a-z]+)-(.+)$/.exec(normalized.toLowerCase());
  const family = account ? harnessDisplayLabels[account[1]!] : undefined;
  return family ? `${family} · ${titleCase(account![2]!)}` : titleCase(normalized);
}

const kindKeys: Record<AgentCapabilityKind, string> = { instruction: "instruction", "mcp-server": "mcpServer", tool: "tool", skill: "skill", context: "context", extension: "extension" };
const mutabilityKeys: Record<CapabilityMutability, string> = { immediate: "immediate", "session-create": "sessionCreate", "requires-restart": "requiresRestart", immutable: "immutable" };
export type CapabilityFact = { id: string; label: string; value: string; description: string; application?: string; unsupported?: boolean };

export function projectionFacts(row: HarnessSnapshot, t: Translate = englishTranslate): CapabilityFact[] {
  return (Object.keys(kindKeys) as AgentCapabilityKind[]).map((kind) => {
    const support = row.capabilitySupport?.kinds[kind];
    const remoteBlocked = row.context.remote && support?.remote === false;
    const modes: readonly CapabilityProjectionMode[] | undefined = remoteBlocked ? ["unsupported"] : support?.modes;
    const unsupported = modes?.length === 0 || modes?.every((mode) => mode === "unsupported");
    return {
      id: kind, label: t(`presentation.kind.${kindKeys[kind]}`),
      value: unsupported ? t("presentation.mode.unsupported") : modes?.map((mode) => t(`presentation.mode.${mode}`)).join(" / ") ?? t("presentation.notVerified"),
      unsupported,
      application: support && !unsupported ? t(`presentation.application.${mutabilityKeys[support.mutability]}`) : undefined,
      description: remoteBlocked ? t("presentation.remoteBlocked")
        : [modes?.map((mode) => t(`presentation.modeDesc.${mode}`)).join(" ") ?? t("presentation.noSupportMetadata"),
          support && !unsupported ? t("presentation.appliesWhen", { mutability: t(`presentation.mutability.${mutabilityKeys[support.mutability]}`) }) : "",
          support?.configScope && !unsupported ? t("presentation.configScope", { scope: support.configScope }) : ""].filter(Boolean).join(" "),
    };
  });
}

const featureIds = ["streaming", "permissions", "questions", "subagents", "resume", "fork", "steering", "compaction", "usage", "cost", "mcp", "title", "contextOccupancy"] as const satisfies ReadonlyArray<keyof RuntimeCapabilities>;
/** The harness reports free-form tokens for some features ("native"); those
 *  pass through capitalized because they are its own words. */
export const supportLabel = (value: unknown, t: Translate = englishTranslate): string => value === true ? t("presentation.supported") : value === false || value === "unsupported" ? t("presentation.mode.unsupported")
  : typeof value === "string" ? value.charAt(0).toUpperCase() + value.slice(1) : t("presentation.notVerified");
export const runtimeFacts = (row: HarnessSnapshot, t: Translate = englishTranslate): CapabilityFact[] => featureIds.map((id) => ({
  id, label: t(`presentation.feature.${id}`), value: supportLabel(row.capabilities?.[id], t), description: t("presentation.runtimeFactDesc"),
  unsupported: row.capabilities?.[id] === false || row.capabilities?.[id] === "unsupported",
}));
export const attachmentFacts = (row: HarnessSnapshot, t: Translate = englishTranslate): CapabilityFact[] => {
  // A PDF the harness cannot take is still delivered: Polyth projects its text.
  const projected = row.capabilities ? effectiveAttachmentDelivery(row.capabilities, undefined, false).projected : [];
  return (["image", "file", "pdf", "url", "audio"] as const).map((id) => projected.includes(id) ? {
    id, label: t(`presentation.attachment.${id}`), value: t("presentation.mode.emulated"),
    description: t("presentation.attachmentPdfProjectedDesc"),
    unsupported: false,
  } : {
    id, label: t(`presentation.attachment.${id}`), value: supportLabel(row.capabilities?.attachments?.modalities[id], t),
    description: t("presentation.attachmentFactDesc"),
    unsupported: row.capabilities?.attachments?.modalities[id] === "unsupported",
  });
};
/** Detail sections for one harness. A shared (`*`) section with
 *  `requires: "accounts"` appears only on multi-account harness families;
 *  `requires: "native-plugins"` only on harnesses whose provider can list
 *  their own native plugins; `requires: "native-skills"` likewise for skills.
 *  A harness's own section may list shared section ids in `replaces` (OpenCode's
 *  native Providers & Models stands in for the shared Models section). */
export function configurationSections(
  items: Array<{ id: string; order: number; meta?: Readonly<Record<string, unknown>> }>,
  harnessId: string,
  identity?: Pick<HarnessSnapshot["identity"], "accounts" | "nativePlugins" | "nativeSkills">,
) {
  const sectionOf = (item: { id: string; meta?: Readonly<Record<string, unknown>> }) => String(item.meta?.sectionId ?? item.id);
  const replaced = new Set(items
    .filter((item) => item.meta?.harnessId === harnessId && Array.isArray(item.meta?.replaces))
    .flatMap((item) => (item.meta!.replaces as unknown[]).filter((id): id is string => typeof id === "string")));
  const sections = items.filter((item) => item.meta?.harnessId === harnessId || item.meta?.harnessId === "*")
    .filter((item) => item.meta?.harnessId !== "*" || !replaced.has(sectionOf(item)))
    .filter((item) => item.meta?.requires !== "accounts" || Boolean(identity?.accounts))
    .filter((item) => item.meta?.requires !== "native-plugins" || identity?.nativePlugins === true)
    .filter((item) => item.meta?.requires !== "native-skills" || identity?.nativeSkills === true)
    .map((item) => ({ id: sectionOf(item), label: String(item.meta?.label ?? item.id), order: item.order, ...(item.meta?.handlesPendingChanges === true ? { handlesPendingChanges: true } : {}) }))
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // Several contributions may fill one section (the shared Runtime restart/update
  // and OpenCode's own process facts); the slot renders them together, so the
  // section is one tab at its earliest position.
  const byId = new Map<string, (typeof sections)[number]>();
  for (const section of sections) {
    const first = byId.get(section.id);
    if (!first) byId.set(section.id, section);
    else if (section.handlesPendingChanges) byId.set(section.id, { ...first, handlesPendingChanges: true });
  }
  return [...byId.values()];
}
