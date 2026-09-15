// UX-COMPOSER-DISC: pure discovery-truth model for the composer.
// Four-state capability catalogs (loading / available / empty / unavailable),
// safe token-insertion decisions for the Add menu, stable autocomplete option
// ids plus honest status copy, and contract-bounded model detail formatting.
// No DOM, no fetch, no send path — components project this module's decisions.
import type { SnippetDef, StrictListResult } from "@polyth/session/web-api";
import type { ModelDescriptor, ModelDiscoveryState } from "@polyth/contracts";
import {
  commandPrecedence,
  extensionCommandBinding,
  type CatalogCommand,
} from "@polyth/commands/catalog";
import { filterSnippets, type AutocompleteItem } from "../utils.ts";
import { tr } from "../i18n/index.ts";

// ---------------------------------------------------------------- catalogs

/** The four honest presentation states. `empty` requires a successful
 *  authoritative response with zero items; `unavailable` is a failed request
 *  or an absent prerequisite. They are never collapsed. */
export type CatalogState<T> =
  | { state: "loading" }
  | { state: "available"; items: T[] }
  | { state: "empty" }
  | { state: "unavailable"; reason: string };

export const CATALOG_LOADING: CatalogState<never> = { state: "loading" };

export function catalogFromResult<T>(result: StrictListResult<T> | null): CatalogState<T> {
  if (result === null) return { state: "loading" };
  if (!result.ok) return { state: "unavailable", reason: result.reason };
  if (result.items.length === 0) return { state: "empty" };
  return { state: "available", items: result.items };
}

/**
 * The models the current harness can actually route to, in one of the four
 * honest states. A model is harness-qualified, so switching harness switches
 * the catalog; "still discovering" and "this engine cannot answer" must never
 * render as "this engine has no models".
 */
export function harnessModelCatalog(input: {
  models: readonly ModelDescriptor[];
  harnessId?: string;
  discovery: ModelDiscoveryState;
}): CatalogState<ModelDescriptor> {
  const owned = input.harnessId
    ? input.models.filter((model) => !model.harnessId || model.harnessId === input.harnessId)
    : input.models;
  const chat = owned.filter(modelSupportsTextWorkflow);
  if (chat.length > 0) return { state: "available", items: chat };
  if (input.discovery.state === "unavailable") {
    return { state: "unavailable", reason: input.discovery.reason };
  }
  if (input.discovery.state === "pending") return { state: "loading" };
  return { state: "empty" };
}

/**
 * Whether the composer is missing a selectable model. An empty catalog plus
 * `nativeDefault` means the engine owns a hidden native model — that is not
 * an absence. Loading and unavailable always are, so they never wait behind
 * an 8-second blank picker.
 */
export function composerModelAbsence(input: {
  catalog: CatalogState<ModelDescriptor>;
  nativeDefault: boolean;
}): "none" | "loading" | "unavailable" | "empty" {
  if (input.catalog.state === "available") return "none";
  if (input.nativeDefault && input.catalog.state === "empty") return "none";
  if (input.catalog.state === "loading") return "loading";
  if (input.catalog.state === "unavailable") return "unavailable";
  return "empty";
}

// ---------------------------------------------------------------- insertion

export interface InsertPlan { text: string; caret: number }

const endsAtBoundary = (prefix: string): boolean =>
  prefix === "" || /[\s(]$/.test(prefix);

/** Insert an `@` or `#` token at the caret with the whitespace the prompt
 *  grammar requires: a separating space before when the caret touches a word,
 *  and a space after when the caret touches following text (so the new token
 *  never absorbs existing prose). Caret lands right after the sigil. */
export function planSigilInsert(text: string, caret: number, sigil: "@" | "#"): InsertPlan {
  const at = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, at);
  const suffix = text.slice(at);
  const lead = endsAtBoundary(prefix) ? "" : " ";
  const trail = suffix === "" || /^\s/.test(suffix) ? "" : " ";
  return {
    text: `${prefix}${lead}${sigil}${trail}${suffix}`,
    caret: prefix.length + lead.length + 1,
  };
}

/** Insert `/` where the grammar treats it as a command: at a line start with
 *  nothing after it on that line. On nonempty content a newline is inserted
 *  first (and after, when the caret splits a line) — never an inert mid-line
 *  slash. Caret lands right after the slash. */
export function planCommandInsert(text: string, caret: number): InsertPlan {
  const at = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, at);
  const suffix = text.slice(at);
  const atLineStart = prefix === "" || prefix.endsWith("\n");
  const lineEmptyAfter = suffix === "" || suffix.startsWith("\n");
  const lead = atLineStart ? "" : "\n";
  const trail = lineEmptyAfter ? "" : "\n";
  return {
    text: `${prefix}${lead}/${trail}${suffix}`,
    caret: prefix.length + lead.length + 1,
  };
}

export const SHELL_DRAFT_BLOCK = tr("composer.discovery.clearDraftBeforeShell");

export type ShellEntryPlan =
  | { ok: true; text: string; caret: number }
  | { ok: false; reason: string };

/** Shell mode only ever replaces an empty or whitespace-only draft. A drafted
 *  prompt is never reinterpreted as an executable command. */
export function planShellEntry(text: string): ShellEntryPlan {
  if (text.trim() !== "") return { ok: false, reason: SHELL_DRAFT_BLOCK };
  return { ok: true, text: "!", caret: 1 };
}

// ---------------------------------------------------------------- Add menu

export type AddMenuAction =
  | "upload" | "mention" | "github" | "goal"
  | "commands" | "snippets" | "shell";

export interface AddMenuRow {
  id: string;
  kind: "group" | "item";
  label: string;
  /** Plain-language outcome shown before any sigil. */
  description?: string;
  /** Secondary expert hint (the sigil column). */
  hint?: string;
  /** Authoritative catalog state/count line. */
  detail?: string;
  /** Visible reason; row stays operable for reading but never activates. */
  disabledReason?: string;
  action?: AddMenuAction;
}

export const OPEN_PROJECT_FIRST = tr("composer.discovery.openProjectFirst");
export const OPEN_SESSION_FIRST = tr("composer.discovery.openSessionFirst");

function catalogDetail(kind: "commands" | "snippets", state: CatalogState<unknown>): string {
  if (state.state === "loading") return tr("common.loading");
  if (state.state === "unavailable") return tr("composer.discovery.currentlyUnavailable");
  if (state.state === "empty") return kind === "commands"
    ? tr("composer.discovery.noCommandsAvailable")
    : tr("composer.discovery.noSnippetsYet");
  const n = state.items.length;
  return tr("composer.discovery.valueAvailable", { value: n });
}

export function addMenuRows(input: {
  hasProject: boolean;
  hasSession: boolean;
  goalsEnabled: boolean;
  draftText: string;
  commands: CatalogState<unknown>;
  snippets: CatalogState<unknown>;
  uploadDisabledReason?: string;
}): AddMenuRow[] {
  const needsProject = input.hasProject ? undefined : OPEN_PROJECT_FIRST;
  const shellBlock = needsProject
    ?? (input.draftText.trim() !== "" ? SHELL_DRAFT_BLOCK : undefined);
  const rows: AddMenuRow[] = [
    { id: "group-context", kind: "group", label: tr("composer.discovery.addContext") },
    {
      id: "upload", kind: "item", label: tr("composer.discovery.uploadFiles"), action: "upload",
      description: tr("composer.discovery.copiesFilesIntoThisProjectSInbox"),
      ...(needsProject || input.uploadDisabledReason
        ? { disabledReason: needsProject ?? input.uploadDisabledReason }
        : {}),
    },
    {
      id: "mention", kind: "item", label: tr("composer.discovery.mentionProjectFile"), action: "mention", hint: "@",
      ...(needsProject ? { disabledReason: needsProject } : {}),
    },
    {
      id: "github", kind: "item", label: tr("composer.discovery.linkGithubIssueOrPullRequest"), action: "github",
      description: tr("composer.discovery.addsALinkOnly"),
      ...(needsProject ? { disabledReason: needsProject } : {}),
    },
  ];
  if (input.goalsEnabled) {
    rows.push({
      id: "goal", kind: "item", label: tr("composer.discovery.attachGoal"), action: "goal",
      ...(input.hasSession ? {} : { disabledReason: OPEN_SESSION_FIRST }),
    });
  }
  rows.push(
    { id: "group-compose", kind: "group", label: tr("composer.discovery.compose") },
    {
      id: "commands", kind: "item", label: tr("composer.discovery.commands"), action: "commands", hint: "/",
      detail: catalogDetail("commands", input.commands),
      ...(needsProject ? { disabledReason: needsProject } : {}),
    },
    {
      id: "snippets", kind: "item", label: tr("composer.discovery.snippets"), action: "snippets", hint: "#",
      detail: catalogDetail("snippets", input.snippets),
      ...(needsProject ? { disabledReason: needsProject } : {}),
    },
    {
      id: "shell", kind: "item", label: tr("composer.discovery.shellCommand"), action: "shell", hint: "!",
      description: tr("composer.discovery.permissionCheckedOutputIsAddedToContext"),
      ...(shellBlock ? { disabledReason: shellBlock } : {}),
    },
  );
  return rows;
}

// ---------------------------------------------------------------- autocomplete

/** Stable DOM-safe option id derived from token kind + item identity (never
 *  the array index). */
export function autocompleteOptionId(kind: "cmd" | "snip" | "file", identity: string): string {
  const safe = identity.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}`);
  return `composer-ac-${kind}-${safe}`;
}

export type ComposerCommand = CatalogCommand;

export interface AutocompleteOption extends AutocompleteItem {
  id: string;
  command?: ComposerCommand;
}

export interface AutocompleteViewState {
  kind: "cmd" | "snip" | "file";
  options: AutocompleteOption[];
  /** Instructional / loading / empty / error body. Null when options exist. */
  status: { text: string; createSnippet?: boolean } | null;
}

export function commandAutocomplete(
  catalog: CatalogState<ComposerCommand>, query: string,
): AutocompleteViewState {
  if (catalog.state === "loading") {
    return { kind: "cmd", options: [], status: { text: tr("composer.discovery.loadingCommands") } };
  }
  if (catalog.state === "unavailable") {
    return { kind: "cmd", options: [], status: { text: tr("composer.discovery.commandsUnavailable") } };
  }
  if (catalog.state === "empty") {
    return { kind: "cmd", options: [], status: { text: tr("composer.discovery.noCommandsAvailable") } };
  }
  const normalized = query.toLowerCase();
  const options = catalog.items
    .filter((command) => {
      const description = command.description ?? "";
      return command.name.toLowerCase().includes(normalized)
        || description.toLowerCase().includes(normalized)
        || ("aliases" in command && command.aliases?.some((alias) => alias.toLowerCase().includes(normalized)));
    })
    .map((command) => {
      const native = "invocation" in command;
      const extension = native ? null : extensionCommandBinding(command);
      const identity = command.id
        ?? `polyth:${"scope" in command ? command.scope : "builtin"}:${command.name}`;
      const detail = native
        ? [command.description, `native · ${command.harnessId}`].filter(Boolean).join(" · ")
        : extension
          ? [command.description, `extension · ${extension.packageId}`].filter(Boolean).join(" · ")
          : [command.description, "scope" in command ? command.scope : undefined].filter(Boolean).join(" · ");
      return {
        label: `/${command.name}`,
        detail,
        value: `/${command.name} `,
        id: autocompleteOptionId("cmd", identity),
        command,
      };
    });
  if (options.length === 0) {
    return { kind: "cmd", options, status: { text: tr("composer.discovery.noCommandsMatch", { query }) } };
  }
  return { kind: "cmd", options, status: null };
}

export { commandPrecedence, mergeCommandCatalog } from "@polyth/commands/catalog";

/** Resolve the exact catalog command selected/typed into the compact command
 * wire shape. Native runtime commands keep their runtime id; extension
 * commands reuse their host-reserved id and are intercepted before session admission. */
export function nativeCommandInput(
  text: string,
  catalog: readonly ComposerCommand[],
  selected?: ComposerCommand,
): { id: string; args?: string } | undefined {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/^\/([A-Za-z0-9_-]+)(?:[ \t]+(.*))?$/);
  if (!match) return undefined;
  const name = match[1]!;
  const selectedExtension = selected && !("invocation" in selected)
    ? extensionCommandBinding(selected)
    : null;
  const selectedMatch = selected
    && selected.name.toLowerCase() === name.toLowerCase()
    && ("invocation" in selected || selectedExtension)
    ? selected
    : undefined;
  const winner = selectedMatch ?? commandPrecedence(name, catalog);
  if (!winner) return undefined;
  const args = match[2]?.trim();
  if ("invocation" in winner) {
    return {
      id: winner.id,
      ...(args ? { args } : {}),
    };
  }
  if (extensionCommandBinding(winner) && winner.id) {
    return {
      id: winner.id,
      ...(args ? { args } : {}),
    };
  }
  return undefined;
}

export function snippetAutocomplete(
  catalog: CatalogState<SnippetDef>, query: string,
): AutocompleteViewState {
  if (catalog.state === "loading") {
    return { kind: "snip", options: [], status: { text: tr("composer.discovery.loadingSnippets") } };
  }
  if (catalog.state === "unavailable") {
    return { kind: "snip", options: [], status: { text: tr("composer.discovery.snippetsUnavailable") } };
  }
  if (catalog.state === "empty") {
    return { kind: "snip", options: [], status: { text: tr("composer.discovery.noSnippetsYet"), createSnippet: true } };
  }
  const options = filterSnippets(catalog.items, query)
    .map((o) => ({ ...o, id: autocompleteOptionId("snip", o.label.slice(1)) }));
  if (options.length === 0) {
    return { kind: "snip", options, status: { text: tr("composer.discovery.noSnippetsMatch", { query }) } };
  }
  return { kind: "snip", options, status: null };
}

export function fileAutocomplete(
  query: string,
  phase: "idle" | "pending" | "done",
  hits: Array<{ path: string; kind: "file" | "dir" }>,
): AutocompleteViewState {
  if (query.length === 0) {
    return { kind: "file", options: [], status: { text: tr("composer.discovery.typeFileOrFolder") } };
  }
  if (phase !== "done") {
    return { kind: "file", options: [], status: { text: tr("composer.discovery.searchingProjectFiles") } };
  }
  if (hits.length === 0) {
    return { kind: "file", options: [], status: { text: tr("composer.discovery.noProjectFilesMatch", { query }) } };
  }
  const options = hits.map((h) => ({
    id: autocompleteOptionId("file", h.path),
    label: `@${h.path}`,
    detail: h.kind === "dir" ? tr("composer.discovery.folder") : tr("composer.discovery.file"),
    value: `@${h.path}${h.kind === "dir" ? "/" : " "}`,
  }));
  return { kind: "file", options, status: null };
}

// ---------------------------------------------------------------- model truth

/** `ModelDescriptor.context` is a token count; render only when numeric. */
export function contextTokensLabel(context: unknown): string | null {
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) return null;
  return context >= 1000
    ? tr("modelpicker.valueKContext", { value: Math.round(context / 1000) })
    : tr("modelpicker.valueContext", { value: context });
}

/** Honest model row detail: provider, numeric context, and connection only
 *  when reported. Never cost (unit undefined by contract), never modality or
 *  attachment claims (no normalized vocabulary), never variants. */
export function modelDetail(m: {
  providerID: string; providerName?: string; context?: number; connected?: boolean;
}): string {
  const parts: string[] = [m.providerName || m.providerID];
  const ctx = contextTokensLabel(m.context);
  if (ctx) parts.push(ctx);
  if (m.connected === false) parts.push(tr("settings.modelspage.notConnected"));
  return parts.join(" · ");
}

/** Providers that report modality metadata must support text input and text
 * output to appear in chat/coding workflows. Older providers without a
 * normalized modality report remain available for backward compatibility. */
export function modelSupportsTextWorkflow(m: { capabilities?: string[] }): boolean {
  const capabilities = m.capabilities ?? [];
  const reportsInput = capabilities.some((capability) => capability.startsWith("input:"));
  const reportsOutput = capabilities.some((capability) => capability.startsWith("output:"));
  return (!reportsInput || capabilities.includes("input:text"))
    && (!reportsOutput || capabilities.includes("output:text"));
}

/** Human labels stay concise when unique and gain a stable provider/model
 * suffix only when catalog names collide. */
export function modelDisplayName(
  model: { providerID: string; modelID: string; name: string },
  catalog: readonly { providerID: string; modelID: string; name: string }[],
): string {
  const name = model.name.trim() || model.modelID;
  const nameKey = name.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase();
  const duplicates = catalog.filter((candidate) =>
    (candidate.name.trim() || candidate.modelID)
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase() === nameKey);
  return duplicates.length > 1 ? `${name} · ${model.providerID}/${model.modelID}` : name;
}

export const ATTACHMENT_COMPAT_NOTE =
  tr("composer.discovery.attachmentCompatibilityNotReported");
