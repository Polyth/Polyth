// Pure discovery-truth model for the composer.
// Four-state capability catalogs (loading / available / empty / unavailable),
// safe token-insertion decisions for the Add menu, stable autocomplete option
// ids plus honest status copy, and contract-bounded model detail formatting.
// No DOM, no fetch, no send path — components project this module's decisions.
import type { SnippetDef, StrictListResult } from "@polyth/session/web-api";
import type {
  HarnessTransition,
  ModelDescriptor,
  ModelDiscoveryState,
  ModelRef,
  SessionMentionCandidateDto,
} from "@polyth/contracts";
import {
  commandPrecedence,
  extensionCommandBinding,
  isSkillCommand,
  type CatalogCommand,
} from "@polyth/commands/catalog";
import { filterSnippets, type AutocompleteItem } from "../utils.ts";
import { tr } from "../i18n/index.ts";
import { accessLabel } from "../sessionSharing.ts";
import { mentionTokenFor } from "../sessionPeople.ts";

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

/** Identity match for a harness-qualified model reference. A ref that names a
 *  harness is only satisfied by a catalogue row of that same harness; an
 *  untagged row is OpenCode's, as in the picker. */
export const modelIdentityMatches = (
  candidate: ModelDescriptor,
  ref: ModelRef & { harnessId?: string },
): boolean => candidate.providerID === ref.providerID
  && candidate.modelID === ref.modelID
  && (!ref.harnessId || (candidate.harnessId ?? "opencode") === ref.harnessId);

/** The model a route falls back to when nobody chose one: the first row this
 *  account has not hidden in Settings → Harnesses. Only a catalogue with
 *  every row hidden falls through to its first row, so a route still has a
 *  model to send with. */
export function visibleFallbackModel(
  models: readonly ModelDescriptor[],
  isHidden: (model: ModelDescriptor, harnessId?: string) => boolean,
  harnessId?: string,
  /** Favorite then recent `harness::provider/model` keys, tried in order. */
  preferredKeys: readonly string[] = [],
): ModelDescriptor | undefined {
  // Picker keys carry the row's own harness tag, or none for an untagged row.
  const matches = (model: ModelDescriptor, key: string) => {
    const bare = `${model.providerID}/${model.modelID}`;
    const owner = model.harnessId ?? harnessId;
    return key === bare ? !model.harnessId : key === `${owner}::${bare}`;
  };
  for (const key of preferredKeys) {
    const preferred = models.find((model) => matches(model, key) && !isHidden(model, harnessId));
    if (preferred) return preferred;
  }
  return models.find((model) => !isHidden(model, harnessId)) ?? models[0];
}

/** The row of the model last chosen in a harness's chat picker (`remembered`,
 *  see `@polyth/models/web-prefs` `rememberHarnessModel`), while the route
 *  still lists it and this account has not hidden it. Account-wide recents are
 *  deliberately not consulted: every picker records those, including utility
 *  and settings pickers, and their picks must not steer a chat's route. */
export function lastChosenHarnessModel(
  models: readonly ModelDescriptor[],
  isHidden: (model: ModelDescriptor, harnessId?: string) => boolean,
  harnessId: string | undefined,
  remembered: Pick<ModelRef, "providerID" | "modelID"> | undefined,
): ModelDescriptor | undefined {
  if (!harnessId || !remembered) return undefined;
  return models.find((model) => (model.harnessId ?? harnessId) === harnessId
    && model.providerID === remembered.providerID
    && model.modelID === remembered.modelID
    && !isHidden(model, harnessId));
}

type RouteModelRef = ModelRef & { harnessId?: string };

/**
 * Whether the person moved this route to another harness: a harness staged
 * for an open chat's next message (its submit carries the model as the target
 * leg's launch), or a harness tab chosen in a new chat. A server-side pending
 * transition alone does not count: it launches with its own recorded intent
 * (see `nextTurnModelRef`).
 */
export function routeSwitchedByPerson(input: {
  hasSession: boolean;
  /** The pinned harness staged for the open chat's next message. */
  stagedHarnessId?: string;
  resolvedHarnessId?: string;
  draftHarnessExplicit?: boolean;
}): boolean {
  return input.hasSession
    ? Boolean(input.stagedHarnessId && input.stagedHarnessId !== input.resolvedHarnessId)
    : input.draftHarnessExplicit === true;
}

type RouteTransition = Pick<HarnessTransition, "targetHarnessId" | "launch">;

/**
 * A server-side pending transition that moves an open chat to another
 * harness. One that keeps the harness — a runtime restart, a rewind or
 * compaction leg, a stale-history reset — is not a route change: the chat
 * keeps its model.
 */
export function routeMovingTransition<T extends RouteTransition>(
  transition: T | undefined,
  resolvedHarnessId: string | undefined,
): T | undefined {
  return transition && transition.targetHarnessId !== resolvedHarnessId ? transition : undefined;
}

/**
 * The model the next message names before the route's catalogue qualifies it
 * (`sendableRouteModel`), shared by the effort control, the send and a steered
 * queue item. An explicit choice wins. A staged harness leaves the chat's
 * model behind with its old route. A server-side switch to another harness
 * that nothing staged here (`routeMovingTransition`) names nothing more: it
 * launches with its own recorded intent, or its harness's default, and a
 * message sent meanwhile follows that rather than a model of the old route.
 * Otherwise the chat's model, then the profile's, then the route default.
 */
export function nextTurnModelRef(input: {
  configModel?: RouteModelRef;
  stagedHarness: boolean;
  movingTransition: boolean;
  sessionModel?: RouteModelRef;
  profileModel?: RouteModelRef;
  preferred?: RouteModelRef;
}): RouteModelRef | undefined {
  if (input.configModel) return input.configModel;
  if (!input.stagedHarness && input.movingTransition) return undefined;
  return (input.stagedHarness ? undefined : input.sessionModel) ?? input.profileModel ?? input.preferred;
}

/**
 * The model the composer's chip names when nothing is chosen for the next
 * message (`cfg.model` takes precedence in the picker itself).
 * - A staged harness leaves the chat's model behind with its old route,
 *   exactly as the send resolves it: the route model, or the display-only
 *   anchor while that route has none.
 * - Otherwise a server-side switch to another harness
 *   (`routeMovingTransition`) runs what it recorded: its launch model, else
 *   the target harness's own default, which the composer cannot name, so only
 *   the display-only anchor (if any) stands in.
 * - Otherwise the chat's model, then the route model.
 */
export function composerChipModel(input: {
  stagedHarness: boolean;
  movingTransition?: RouteTransition;
  /** Already qualified with the chat's resolved harness. */
  sessionModel?: RouteModelRef;
  routeModel?: RouteModelRef;
  pendingRouteModel?: RouteModelRef;
}): RouteModelRef | undefined {
  const { stagedHarness, movingTransition, sessionModel, routeModel, pendingRouteModel } = input;
  if (stagedHarness) return routeModel ?? pendingRouteModel;
  if (movingTransition) {
    const launched = movingTransition.launch?.model;
    return launched ? { ...launched, harnessId: movingTransition.targetHarnessId } : pendingRouteModel;
  }
  return sessionModel ?? routeModel;
}

/**
 * The model a route runs with nothing chosen for it. A harness switch comes
 * back to the model last chosen in that harness, ahead of any project or global
 * default. Otherwise — and when that harness has no remembered pick — a
 * remembered default this route cannot run (another harness, or one the caller
 * may no longer use) quietly gives way to the fallback (favorite, recent, first
 * shown). `route` is the one this route's catalogue lists — what the picker
 * shows and a send commits — and is undefined while that catalogue is empty.
 */
export function routeDefaultModel(input: {
  models: readonly ModelDescriptor[];
  /** The person moved the route to this harness. */
  switched: boolean;
  lastChosen?: ModelDescriptor;
  /** The project, then global, default, else `fallback`. */
  resolvedDefault?: RouteModelRef;
  fallback?: ModelDescriptor;
}): { preferred?: RouteModelRef; route?: RouteModelRef } {
  const { models, switched, lastChosen, resolvedDefault, fallback } = input;
  const listed = (ref: RouteModelRef) => models.some((candidate) => modelIdentityMatches(candidate, ref));
  const preferred = switched && lastChosen
    ? lastChosen
    : resolvedDefault && models.length > 0 && !listed(resolvedDefault)
      ? fallback
      : resolvedDefault;
  const route = preferred && listed(preferred) ? preferred : fallback;
  return {
    ...(preferred ? { preferred } : {}),
    ...(route ? { route } : {}),
  };
}

/**
 * The catalogue row a send may commit for the current route, or undefined.
 * Every route change replaces the qualified catalogue, so a model the current
 * route cannot route (typically the previous harness's selection) is dropped
 * here instead of being sent as an identity the engine would refuse.
 */
export function sendableRouteModel(
  models: readonly ModelDescriptor[],
  selected: (ModelRef & { harnessId?: string }) | undefined,
): ModelDescriptor | undefined {
  return selected ? models.find((candidate) => modelIdentityMatches(candidate, selected)) : undefined;
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

/** Client-owned copy for a structured empty-catalog cause. The server sends
 *  the cause as a code, never untranslated prose, so every locale can say the
 *  same thing and the recovery button can match the actual remedy. */
export function emptyModelCatalogReason(discovery: ModelDiscoveryState | undefined): string | undefined {
  if (discovery?.state !== "empty") return undefined;
  if (discovery.code === "models-hidden") return tr("composer.modelsHiddenForThisAccount");
  if (discovery.code === "runtime-empty") return tr("composer.runtimeReportedNoModels");
  return undefined;
}

/**
 * Timing contract for a transient capability gap. A harness switch replaces the
 * qualified model catalogue, so the composer can spend a moment with no answer
 * for the new route. That moment is not "this engine has no models": never
 * claim absence before the grace elapses, and never flash a notice that has
 * already been shown.
 */
export const MODEL_ABSENCE_GRACE_MS = 600;
export const MODEL_ABSENCE_MIN_VISIBLE_MS = 400;

export interface ModelAbsenceGate {
  /** When the current absence began, or null while the catalogue is present. */
  since: number | null;
  /** Earliest instant a visible notice may hide, or null when none is shown. */
  until: number | null;
  visible: boolean;
  /** Next instant the gate changes on its own, for the caller's timer. */
  nextChangeAt: number | null;
}

export const IDLE_MODEL_ABSENCE_GATE: ModelAbsenceGate = {
  since: null,
  until: null,
  visible: false,
  nextChangeAt: null,
};

/** Advance the absence gate. Pure: the caller owns the clock and the timer. */
export function advanceModelAbsenceGate(
  gate: ModelAbsenceGate,
  absent: boolean,
  now: number,
  delayMs: number = MODEL_ABSENCE_GRACE_MS,
): ModelAbsenceGate {
  if (!absent) {
    // Once a notice is on screen it keeps its minimum beat, so a catalogue that
    // answers just after the grace cannot blink it away.
    if (gate.until === null || now >= gate.until) return IDLE_MODEL_ABSENCE_GATE;
    return { since: gate.since, until: gate.until, visible: true, nextChangeAt: gate.until };
  }
  const since = gate.since ?? now;
  if (gate.until !== null) {
    // Already shown: it stays until the absence clears and its beat is over.
    return { since, until: gate.until, visible: true, nextChangeAt: now >= gate.until ? null : gate.until };
  }
  if (now - since >= delayMs) {
    const until = now + MODEL_ABSENCE_MIN_VISIBLE_MS;
    return { since, until, visible: true, nextChangeAt: until };
  }
  return { since, until: null, visible: false, nextChangeAt: since + delayMs };
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
  | "camera" | "photos" | "upload" | "mention"
  | "commands" | "snippets" | "shell";

export interface AddMenuRow {
  id: string;
  kind: "group" | "item";
  label: string;
  /** Attach source drawn as a tile above the rows: camera, photos, files.
   *  Each source has exactly one entry, never a tile plus a row. */
  tile?: boolean;
  /** Plain-language outcome shown before any sigil; a tile's full name. */
  description?: string;
  /** Secondary expert hint (the sigil column). */
  hint?: string;
  /** Authoritative catalog state/count line. */
  detail?: string;
  /** Visible reason; row stays operable for reading but never activates. */
  disabledReason?: string;
  action?: AddMenuAction;
  /** Contributed item id; activation belongs to the registering package. */
  contributionId?: string;
}

/** A package-owned Add-menu item resolved into the host row model. */
export interface AddMenuContributionRow {
  id: string;
  label: string;
  description?: string;
  order: number;
}

export const OPEN_PROJECT_FIRST = tr("composer.discovery.openProjectFirst");

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
  draftText: string;
  commands: CatalogState<unknown>;
  snippets: CatalogState<unknown>;
  /** Available package contributions, already sorted by the host registry. */
  contributions?: readonly AddMenuContributionRow[];
  uploadDisabledReason?: string;
  /** Protected mode: the server refuses `!` shell, so the row is not offered. */
  shellHidden?: boolean;
  /** The device has a camera the browser or native shell can open directly. */
  canCapturePhoto?: boolean;
}): AddMenuRow[] {
  const needsProject = input.hasProject ? undefined : OPEN_PROJECT_FIRST;
  const shellBlock = needsProject
    ?? (input.draftText.trim() !== "" ? SHELL_DRAFT_BLOCK : undefined);
  // Every attach source lands in the same project `_inbox`, so one reason
  // blocks all of them together.
  const attachBlock = needsProject ?? input.uploadDisabledReason;
  const attach = (id: AddMenuAction, label: string, description: string): AddMenuRow => ({
    id, kind: "item", tile: true, label, description, action: id,
    ...(attachBlock ? { disabledReason: attachBlock } : {}),
  });
  const rows: AddMenuRow[] = [
    ...(input.canCapturePhoto
      ? [attach("camera", tr("composer.discovery.camera"), tr("composer.discovery.takePhoto"))]
      : []),
    attach("photos", tr("composer.discovery.photos"), tr("composer.discovery.choosePhotos")),
    attach("upload", tr("composer.files"), tr("composer.discovery.uploadFiles")),
    { id: "group-context", kind: "group", label: tr("composer.discovery.addContext") },
    {
      id: "mention", kind: "item", label: tr("composer.discovery.mentionProjectFile"), action: "mention", hint: "@",
      ...(needsProject ? { disabledReason: needsProject } : {}),
    },
  ];
  for (const contribution of input.contributions ?? []) {
    rows.push({
      id: `contribution:${contribution.id}`,
      kind: "item",
      label: contribution.label,
      contributionId: contribution.id,
      ...(contribution.description ? { description: contribution.description } : {}),
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
  );
  if (!input.shellHidden) {
    rows.push({
      id: "shell", kind: "item", label: tr("composer.discovery.shellCommand"), action: "shell", hint: "!",
      description: tr("composer.discovery.permissionCheckedOutputIsAddedToContext"),
      ...(shellBlock ? { disabledReason: shellBlock } : {}),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- autocomplete

/** Stable DOM-safe option id derived from token kind + item identity (never
 *  the array index). */
export function autocompleteOptionId(kind: "cmd" | "snip" | "file" | "person", identity: string): string {
  const safe = identity.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.codePointAt(0)!.toString(16)}`);
  return `composer-ac-${kind}-${safe}`;
}

export type ComposerCommand = CatalogCommand;

export type AutocompletePresentationKind = "command" | "skill" | "settings" | "person" | "file";

export interface AutocompletePresentation {
  kind: AutocompletePresentationKind;
  kindLabel: string;
  groupId: "people" | "project" | "space" | "personal" | "builtin" | "plugins" | "agent" | "customize" | "files";
  groupLabel: string;
  /** More specific provenance inside the group, such as OpenCode or a package id. */
  sourceLabel?: string;
}

export interface AutocompleteOption extends AutocompleteItem {
  id: string;
  command?: ComposerCommand;
  presentation?: AutocompletePresentation;
  argumentHint?: string;
  destination?: { pageId: "commands" | "skills" | "behavior" };
  /** A person picked from the People group; the composer records the id. */
  person?: { userId: string; name: string; token: string };
}

export interface AutocompleteGroup {
  id: string;
  label: string;
  options: AutocompleteOption[];
}

export interface AutocompleteViewState {
  kind: "cmd" | "snip" | "file";
  options: AutocompleteOption[];
  /** Number of matching catalog entries; settings destinations are excluded. */
  resultCount?: number;
  /** Instructional / loading / empty / error body. May accompany recovery destinations. */
  status: { text: string; createSnippet?: boolean } | null;
}

const SLASH_INPUT_NAME = /^[A-Za-z0-9_-]+$/;
export function commandInputName(command: ComposerCommand): string {
  if (SLASH_INPUT_NAME.test(command.name)) return command.name;
  if ("aliases" in command) {
    const alias = command.aliases?.find((candidate) => SLASH_INPUT_NAME.test(candidate));
    if (alias) return alias;
  }
  return command.name;
}

const COMMAND_GROUP_ORDER: Record<AutocompletePresentation["groupId"], number> = {
  people: -1,
  project: 0,
  space: 1,
  personal: 2,
  builtin: 3,
  plugins: 4,
  agent: 5,
  customize: 6,
  files: 7,
};

const sourceName = (value: string): string => {
  const known: Record<string, string> = {
    agents: ".agents",
    antigravity: "Antigravity",
    claude: "Claude",
    codex: "Codex",
    commandcode: "CommandCode",
    opencode: "OpenCode",
    pi: "Pi",
  };
  if (known[value]) return known[value];
  return value.split(/[-_]/g).filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
};

const groupLabel = (groupId: AutocompletePresentation["groupId"]): string => {
  if (groupId === "people") return tr("composer.people.group");
  if (groupId === "files") return tr("composer.files");
  if (groupId === "project") return tr("mobile.sessioncontextbar.project");
  if (groupId === "space") return tr("spaces.title");
  if (groupId === "personal") return tr("settings.commandspage.user");
  if (groupId === "builtin") return tr("starters.builtIn");
  if (groupId === "plugins") return tr("packages.plugins.plugins");
  if (groupId === "agent") return tr("composer.agent");
  return tr("settingsview.customize");
};

function commandPresentation(command: ComposerCommand): AutocompletePresentation {
  const kind: AutocompletePresentationKind = command.kind === "skill" || (!("invocation" in command) && isSkillCommand(command))
    ? "skill"
    : "command";
  const kindLabel = kind === "skill" ? tr("starters.skills") : tr("settings.pages.command");
  const skillScope = command.skillScope;
  if (skillScope) {
    if (skillScope === "space") {
      return { kind, kindLabel, groupId: "space", groupLabel: groupLabel("space") };
    }
    const [scope, provider] = skillScope.split("-", 2);
    const groupId = scope === "project" ? "project" : "personal";
    return {
      kind,
      kindLabel,
      groupId,
      groupLabel: groupLabel(groupId),
      ...(provider ? { sourceLabel: sourceName(provider) } : {}),
    };
  }
  if ("invocation" in command) {
    return {
      kind,
      kindLabel,
      groupId: "agent",
      groupLabel: groupLabel("agent"),
      sourceLabel: sourceName(command.harnessId),
    };
  }
  const extension = extensionCommandBinding(command);
  if (extension) {
    return {
      kind,
      kindLabel,
      groupId: "plugins",
      groupLabel: groupLabel("plugins"),
      sourceLabel: extension.packageId,
    };
  }
  const groupId = command.scope === "project"
    ? "project"
    : command.scope === "user"
      ? "personal"
      : "builtin";
  return { kind, kindLabel, groupId, groupLabel: groupLabel(groupId) };
}

const matchRank = (
  query: string,
  name: string,
  aliases: readonly string[],
  searchable: readonly string[],
): number | null => {
  if (!query) return 0;
  const names = [name, ...aliases].map((value) => value.toLowerCase());
  if (names.some((value) => value === query)) return 0;
  if (names.some((value) => value.startsWith(query))) return 1;
  if (names.some((value) => value.includes(query))) return 2;
  return searchable.some((value) => value.toLowerCase().includes(query)) ? 3 : null;
};

function settingsDestinations(query: string): AutocompleteOption[] {
  const presentation: AutocompletePresentation = {
    kind: "settings",
    kindLabel: tr("common.settings"),
    groupId: "customize",
    groupLabel: groupLabel("customize"),
  };
  const rows: Array<AutocompleteOption & { keywords: string[] }> = [
    {
      id: autocompleteOptionId("cmd", "settings:commands"),
      label: tr("settings.commandspage.commandsSnippets"),
      detail: tr("settings.pages.manageReusablePromptsUnderCommands"),
      value: "",
      presentation,
      destination: { pageId: "commands" },
      keywords: ["command", "commands", "prompt", "snippet", "custom"],
    },
    {
      id: autocompleteOptionId("cmd", "settings:skills"),
      label: tr("starters.skills2"),
      detail: "",
      value: "",
      presentation,
      destination: { pageId: "skills" },
      keywords: ["skill", "skills", "instruction", "custom", "project", "space"],
    },
    {
      id: autocompleteOptionId("cmd", "settings:behavior"),
      label: tr("settingsview.behavior"),
      detail: tr("settings.registry.behaviorTextAppliedToEveryAgentGlobal"),
      value: "",
      presentation,
      destination: { pageId: "behavior" },
      keywords: ["behavior", "rule", "rules", "instruction", "system", "prompt"],
    },
  ];
  if (!query) return rows.map(({ keywords: _keywords, ...row }) => row);
  return rows.flatMap(({ keywords, ...row }) =>
    [row.label, row.detail, ...keywords].some((value) => value.toLowerCase().includes(query)) ? [row] : []);
}

export function groupAutocompleteOptions(options: readonly AutocompleteOption[]): AutocompleteGroup[] {
  const groups = new Map<string, AutocompleteGroup>();
  for (const option of options) {
    const id = option.presentation?.groupId ?? "results";
    const group = groups.get(id) ?? {
      id,
      label: option.presentation?.groupLabel ?? "",
      options: [],
    };
    group.options.push(option);
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) =>
    (COMMAND_GROUP_ORDER[left.id as keyof typeof COMMAND_GROUP_ORDER] ?? 99)
      - (COMMAND_GROUP_ORDER[right.id as keyof typeof COMMAND_GROUP_ORDER] ?? 99));
}

export function commandAutocomplete(
  catalog: CatalogState<ComposerCommand>, query: string,
): AutocompleteViewState {
  if (catalog.state === "loading") {
    return { kind: "cmd", options: [], resultCount: 0, status: { text: tr("composer.discovery.loadingCommands") } };
  }
  const normalized = query.trim().toLowerCase();
  const destinations = settingsDestinations(normalized);
  if (catalog.state === "unavailable") {
    return { kind: "cmd", options: destinations, resultCount: 0, status: { text: tr("composer.discovery.commandsUnavailable") } };
  }
  if (catalog.state === "empty") {
    return { kind: "cmd", options: destinations, resultCount: 0, status: { text: tr("composer.discovery.noCommandsAvailable") } };
  }
  const options = catalog.items
    .flatMap((command) => {
      const native = "invocation" in command;
      const identity = command.id
        ?? `polyth:${"scope" in command ? command.scope : "builtin"}:${command.name}`;
      const presentation = commandPresentation(command);
      const aliases = native ? command.aliases ?? [] : [];
      const argumentHint = native ? command.argumentHint : undefined;
      const description = command.description?.trim() ?? "";
      const rank = matchRank(normalized, command.name, aliases, [
        description,
        presentation.kindLabel,
        presentation.groupLabel,
        presentation.sourceLabel ?? "",
        argumentHint ?? "",
      ]);
      if (rank === null) return [];
      const inputName = commandInputName(command);
      return [{
        label: `/${inputName}`,
        detail: description,
        value: `/${inputName} `,
        id: autocompleteOptionId("cmd", identity),
        command,
        presentation,
        ...(argumentHint ? { argumentHint } : {}),
        rank,
      }];
    })
    .sort((left, right) => {
      const group = COMMAND_GROUP_ORDER[left.presentation.groupId] - COMMAND_GROUP_ORDER[right.presentation.groupId];
      if (group !== 0) return group;
      return left.rank - right.rank || left.label.localeCompare(right.label);
    })
    .map(({ rank: _rank, ...option }) => option);
  return {
    kind: "cmd",
    options: [...options, ...destinations],
    resultCount: options.length,
    status: options.length === 0
      ? { text: tr("composer.discovery.noCommandsMatch", { query }) }
      : null,
  };
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
  const selectedNames = selected
    ? [selected.name, ...("aliases" in selected ? selected.aliases ?? [] : [])]
    : [];
  const selectedMatch = selected
    && selectedNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase())
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

export function peopleAutocomplete(
  candidates: readonly SessionMentionCandidateDto[],
  query: string,
): AutocompleteOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  const presentation: AutocompletePresentation = {
    kind: "person",
    kindLabel: tr("composer.people.group"),
    groupId: "people",
    groupLabel: tr("composer.people.group"),
  };
  const everyone = candidates.map((candidate) => candidate.name?.trim() || candidate.userId);
  return candidates
    .filter((candidate) => {
      if (!normalized) return true;
      return (candidate.name ?? "").toLocaleLowerCase().includes(normalized)
        || candidate.userId.toLocaleLowerCase().includes(normalized);
    })
    .map((candidate) => {
      const name = candidate.name?.trim() || candidate.userId;
      const token = mentionTokenFor(name, everyone);
      return {
        id: autocompleteOptionId("person", candidate.userId),
        label: name,
        detail: accessLabel(candidate.access),
        value: `${token} `,
        presentation,
        person: { userId: candidate.userId, name, token },
      };
    });
}

/** One @ picker: People first, then project files. A mention candidate list
 *  the route could not answer leaves the file results untouched. */
export function mentionAndFileAutocomplete(
  people: readonly SessionMentionCandidateDto[],
  query: string,
  phase: "idle" | "pending" | "done",
  hits: Array<{ path: string; kind: "file" | "dir" }>,
): AutocompleteViewState {
  const fileView = fileAutocomplete(query, phase, hits);
  const peopleOptions = peopleAutocomplete(people, query);
  if (peopleOptions.length === 0) return fileView;
  return {
    ...fileView,
    options: [...peopleOptions, ...fileView.options],
    status: null,
  };
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
  const presentation: AutocompletePresentation = {
    kind: "file",
    kindLabel: tr("composer.files"),
    groupId: "files",
    groupLabel: tr("composer.files"),
  };
  const options = hits.map((h) => ({
    id: autocompleteOptionId("file", h.path),
    label: `@${h.path}`,
    detail: h.kind === "dir" ? tr("composer.discovery.folder") : tr("composer.discovery.file"),
    value: `@${h.path}${h.kind === "dir" ? "/" : " "}`,
    presentation,
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
