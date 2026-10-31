// Package taxonomy: what a package adds, what access it needs, and how it
// runs. The host derives the ids from the parsed contribution graph and
// capability list — never from marketing copy — so a settings filter can only
// offer a category a package actually satisfies. Display labels live with the
// consumer (`packages.plugins.classifier.<id>`), keeping this module
// browser-safe, locale-free, and testable without the web app.
import type { DeclaredCapability } from "./capabilities.ts";
import type { PackageContributesV2, PackageManifest } from "./manifest.ts";

export type PackageClassifierGroup = "adds" | "access" | "runtime";

export type PackageClassifierId =
  // what the package adds to the workspace
  | "surface"
  | "widget"
  | "composer"
  | "attachment"
  | "message"
  | "session"
  | "command"
  | "tool"
  | "status"
  | "settings"
  | "context"
  // what it needs to work
  | "network"
  | "credentials"
  | "model"
  | "storage"
  | "workspace"
  | "clipboard"
  | "external"
  // how it runs
  | "server"
  | "sandboxed"
  | "trusted";

/** Stable ordering per group; the settings UI renders filters in this order. */
const ORDER: PackageClassifierId[] = [
  "surface",
  "widget",
  "command",
  "tool",
  "composer",
  "context",
  "attachment",
  "message",
  "session",
  "settings",
  "status",
  "server",
  "sandboxed",
  "trusted",
  "network",
  "credentials",
  "model",
  "workspace",
  "storage",
  "clipboard",
  "external",
];

const GROUP_OF: Record<PackageClassifierId, PackageClassifierGroup> = {
  surface: "adds",
  widget: "adds",
  composer: "adds",
  attachment: "adds",
  message: "adds",
  session: "adds",
  command: "adds",
  tool: "adds",
  status: "adds",
  settings: "adds",
  context: "adds",
  network: "access",
  credentials: "access",
  model: "access",
  storage: "access",
  workspace: "access",
  clipboard: "access",
  external: "access",
  server: "runtime",
  sandboxed: "runtime",
  trusted: "runtime",
};

/** The complete taxonomy in presentation order. Shared by the server (which
 *  derives the ids) and the settings UI (which owns the localized labels), so
 *  a filter chip can never name a category the host does not implement. */
export const PACKAGE_CLASSIFIER_ORDER: ReadonlyArray<{ id: PackageClassifierId; group: PackageClassifierGroup }> =
  ORDER.map((id) => ({ id, group: GROUP_OF[id] }));

export interface PackageClassifier {
  id: PackageClassifierId;
  group: PackageClassifierGroup;
  /** How many contributions of this kind the manifest declares. */
  count: number;
}

/** Capability → access classifier. A capability with no entry is not a
 *  workspace-visible dimension and must not be invented as one. */
const CAPABILITY_CLASSIFIER: Partial<Record<DeclaredCapability["name"], PackageClassifierId>> = {
  "network.fetch": "network",
  "auth.connection": "credentials",
  "model.generate": "model",
  "storage.package": "storage",
  "clipboard.write": "clipboard",
  "ui.openExternalUrl": "external",
  "session.read": "workspace",
  "session.appendContext": "workspace",
  "context.append": "workspace",
  "project.readMetadata": "workspace",
  "attachments.create": "workspace",
};

interface ClassifyInput {
  runtime?: PackageManifest["runtime"];
  capabilities?: readonly DeclaredCapability[];
  connections?: readonly unknown[];
  contributes?: PackageManifest["contributes"];
}

function contributionCounts(contributes: PackageManifest["contributes"]): Partial<Record<PackageClassifierId, number>> {
  const counts: Partial<Record<PackageClassifierId, number>> = {};
  if (!contributes) return counts;
  const add = (id: PackageClassifierId, items: readonly unknown[] | undefined): void => {
    if (items?.length) counts[id] = items.length;
  };
  add("surface", contributes.surfaces);
  add("composer", contributes.composerActions);
  const v2 = contributes as PackageContributesV2;
  add("attachment", v2.attachmentProviders);
  add("message", v2.messageActions);
  add("session", v2.sessionActions);
  add("command", v2.commands);
  add("tool", v2.toolRenderers);
  add("status", v2.statusBadges);
  add("settings", v2.settingsSections);
  add("context", v2.contextProviders);
  add("widget", v2.widgets);
  return counts;
}

/** Human/agent-facing classifiers for one parsed manifest. Deterministic and
 *  free of host state: the same manifest always yields the same ids. */
export function classifyPackage(input: ClassifyInput): PackageClassifier[] {
  const counts = contributionCounts(input.contributes);
  const add = (id: PackageClassifierId, count = 1): void => {
    counts[id] = (counts[id] ?? 0) + count;
  };
  for (const capability of input.capabilities ?? []) {
    const id = CAPABILITY_CLASSIFIER[capability.name];
    if (id) add(id);
  }
  if (input.connections?.length) add("credentials", input.connections.length);
  const runtime = input.runtime;
  add(runtime?.kind === "trusted-local" ? "trusted" : "sandboxed");
  if (runtime?.server) add("server");
  return ORDER.filter((id) => (counts[id] ?? 0) > 0).map((id) => ({
    id,
    group: GROUP_OF[id],
    count: counts[id]!,
  }));
}

/** Classifier ids only, for the wire DTO and filter comparisons. */
export function packageClassifiers(manifest: ClassifyInput): PackageClassifierId[] {
  return classifyPackage(manifest).map((item) => item.id);
}
