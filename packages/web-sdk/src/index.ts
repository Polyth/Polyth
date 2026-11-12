import type { ComponentPropsWithRef, ComponentType, ReactNode, Ref, RefObject } from "react";
import type {
  DraftExecutionConfig,
  JsonObject,
  SessionEvent,
  SessionProjection,
  PackageOnboardingTour,
  UiSlot,
  WidgetKind,
  PanelItemSize,
  Project,
} from "@polyth/contracts";
import { errorBodyText, readErrorDiagnostics } from "@polyth/contracts";
import { fetchWithReadRetry, type ReadRetryOptions } from "@polyth/contracts/transport-retry";

export type Unregister = () => void;
export type CapabilityTier = "primary" | "more" | "technical";

/** Draft context supplied to composer mini-widgets. Replace edits the draft only.
 * Read again before applying async results to preserve navigation and typing. */
export interface ComposerDraftSnapshot {
  projectId: string | null;
  sessionId: string | null;
  text: string;
  revision: number;
  latestSeq: number;
}
/** A package's suggested next prompt for one session's idle composer. */
export interface ComposerSuggestionOffer {
  sessionId: string;
  text: string;
  /** Shown over the harness's own suggestion: the person put this source
   * first, or asked it for a suggestion just now. A preferred offer with empty
   * text holds the chip while that source is still answering, so a harness
   * hint does not flash up and get replaced; withdraw it (`null`) when the
   * source has nothing, and the harness hint shows again. */
  preferred?: boolean;
}
export interface ComposerDraftContext extends ComposerDraftSnapshot {
  busy: boolean;
  read(): ComposerDraftSnapshot;
  replace(text: string): void;
  /** Offer a next prompt the host shows exactly like a harness suggestion: one
   * chip above an idle, empty composer that click or Tab takes as an editable
   * draft (never sent) and × or Esc dismisses. The harness's own suggestion
   * wins unless the offer is `preferred`; `null` withdraws the offer. Offer
   * from a `composer.suggestion` slot contribution, which stays mounted when
   * the person hides or moves rail widgets. Optional for older hosts. */
  offerSuggestion?(offer: ComposerSuggestionOffer | null): void;
  /** The harness's own suggestion currently on offer for this session, if any. */
  harnessSuggestion?: string;
  /** The session's harness reports that it suggests next prompts itself. */
  harnessSuggests?: boolean;
}

export interface SlotRegistration {
  slot: UiSlot;
  id: string;
  render: (props: Record<string, unknown>) => ReactNode;
  order?: number;
  meta?: Record<string, unknown>;
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
}

/** `meta.messageAction` on a `session.message.actions` contribution. The
 *  button then appears in Settings > Chat > Buttons and bars beside the built-in
 *  ones, where the user orders it and places it on the bar, in the "More"
 *  menu, or off. Without it the host still lists the button by its id. */
export interface MessageActionSlotMeta {
  /** The button's name in Settings. Also its "More" menu row, unless `menuLabel`
   *  says otherwise. */
  label: string | (() => string);
  /** The "More" menu row for this message, read each time the menu opens, for
   *  an action whose row says what a press would do ("Remove bookmark"). */
  menuLabel?: (context: Readonly<Record<string, unknown>>) => string;
  description?: string | (() => string);
  /** Glyph for Settings and the "More" menu (a host `ui` icon). */
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Message roles the contribution renders for; both when omitted. */
  roles?: ReadonlyArray<"user" | "assistant">;
  /** The contribution honours `messageActionPlacement: "menu"` (see
   *  MessageActionSlotContext). Bar-only contributions stay on the bar even
   *  when the user folds every action into "More". */
  menu?: boolean;
  /** Whether this message can offer the action; drops its menu entry. */
  available?: (context: Readonly<Record<string, unknown>>) => boolean;
  /** Where the action starts for someone who never placed it; "bar" when
   *  omitted. */
  defaultPlacement?: "bar" | "menu" | "off";
  /** Saved action ids this contribution took over (a retired built-in): a
   *  person's placement of those carries over instead of the default. */
  replaces?: readonly string[];
}

/** Extra context the host gives every `session.message.actions` contribution.
 *  On "bar" the contribution renders its own button. On "menu" the host lists
 *  it in the "More" menu and keeps it mounted without a visible trigger:
 *  render no button, and act when `messageActionRequest` increases (anchor
 *  any popover to `messageActionAnchor()`). */
export interface MessageActionSlotContext {
  messageActionPlacement: "bar" | "menu";
  messageActionRequest: number;
  messageActionAnchor: () => HTMLElement | null;
}

/** `meta.promptTab` on a `session.prompt.tabs` contribution: a tab beside the
 *  prompt list in the chat's bookmark popover. */
export interface PromptTabSlotMeta {
  label: string | (() => string);
  /** This chat has something to show. The tab strip appears only then; until
   *  then the popover is the prompt list plus each tab's "footer" rendering.
   *  It also fills the icon and shows it though its setting is off. */
  hasContent(sessionId: string): boolean;
  /** Notifies when `hasContent` may have changed. */
  subscribe(listener: () => void): Unregister;
}

/** Extra context the host gives every `session.prompt.tabs` contribution.
 *  "tab" is the tab's body. "footer" sits under the prompt list while no tab has
 *  content: render one quiet row or nothing. `closePromptPopover` gives focus
 *  back to the icon, so call it before moving focus elsewhere. */
export interface PromptTabSlotContext {
  sessionId: string;
  projectId: string | null;
  promptTabPlacement: "tab" | "footer";
  closePromptPopover: () => void;
  /** The answer being read when asked, and the heading above the reading line. */
  promptReadingPosition: () => { eventSeq: number; heading?: string } | null;
}

/** The host's copy of a transcript selection, taken while it was alive. */
export interface SelectionActionContext {
  text: string;
  /** The same passage as Markdown, so its links and code survive. */
  markdown: string;
  sessionId: string | null;
  projectId: string | null;
  /** The message the selection starts in; null outside any message. */
  eventSeq: number | null;
  messageRole: "user" | "assistant" | null;
}

/** `meta.selectionAction` on a `session.selection.actions` contribution. The host
 *  draws the button in its floating toolbar and touch dock and clears the
 *  selection after `run`; the contribution's `render` is never mounted. */
export interface SelectionActionSlotMeta {
  label: string | (() => string);
  /** Tooltip; `label` when omitted. */
  title?: string | (() => string);
  /** Glyph in the touch dock (a host `ui` icon). */
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  available?: (context: SelectionActionContext) => boolean;
  run: (context: SelectionActionContext) => void | Promise<void>;
}

/** Package status choice in the Settings → Packages toolbar. */
export type PackagesPageStatus = "all" | "enabled" | "disabled";

/** What a contribution currently lists under the page's find state: its
 *  matches for every status choice (the selected one decides what it shows). */
export interface PackagesPageMatches {
  all: number;
  enabled: number;
  disabled: number;
}

/** Extra context the host's Settings → Packages page gives every
 *  `settings.packages.content` contribution. The page owns one toolbar; a
 *  contribution lists its own packages under that find state instead of a
 *  second search, reports its matches so the toolbar counts and the single
 *  empty state stay honest, and may take the page over for a detail view
 *  (the host hides its toolbar and lists until the contribution gives the
 *  page back). `owner` is the contribution id. */
export interface PackagesPageSlotContext {
  /** Raw toolbar search; every whitespace-separated word must match. */
  packagesQuery: string;
  packagesStatus: PackagesPageStatus;
  /** Host category filter. Packages without a host category do not match
   *  while one is chosen. */
  packagesCategory: string | null;
  reportPackageMatches(owner: string, matches: PackagesPageMatches): void;
  setPackageDetailOpen(owner: string, open: boolean): void;
}

export interface WidgetRenderContext extends Record<string, unknown> {
  projectId: string | null;
  sessionId: string | null;
  editing: boolean;
  instanceId: string;
  config: Readonly<JsonObject>;
  updateConfig: (config: JsonObject) => void;
  /** The size the person chose for this instance in Workspace panel chrome
   *  (one of the widget's `panelSizes`). Absent everywhere else, where the
   *  widget follows the space it is given. */
  panelSize?: PanelItemSize;
  /** Only on the new-chat screen (`session.empty.widgets`): the model its
   *  composer would start the chat on, when one is known. */
  composerModel?: { harnessId: string; providerID: string; modelID: string };
}

/** Bounded context a widget's availability predicate decides on. */
export interface WidgetAvailabilityContext {
  projectId: string | null;
  sessionId: string | null;
  config: Readonly<JsonObject>;
  /** Only on the new-chat screen (`session.empty.widgets`): the model its
   *  composer would start the chat on, when one is known. */
  composerModel?: { harnessId: string; providerID: string; modelID: string };
}

export interface WidgetSettingsContext extends WidgetRenderContext {
  widgetId: string;
}

export interface WidgetSize {
  w: number;
  h: number;
}

export type WidgetAudience = "simple" | "standard" | "power";
export type WidgetScope = "global" | "workspace" | "plugin";
export type WidgetZone = "header" | "left" | "main" | "right" | "bottom" | "floating";
export type { PanelItemSize } from "@polyth/contracts";
export type {
  PackageOnboardingHighlightWhere,
  PackageOnboardingMedia,
  PackageOnboardingStep,
  PackageOnboardingTour,
} from "@polyth/contracts";

export interface WidgetDefinition {
  id: string;
  /**
   * Host-bound owner package id. Package callers should omit this; the
   * activation scope stamps it. Semantic grouping uses `WidgetPlugin.id` /
   * the `pluginId` argument to `widgets.register`, not this field.
   */
  ownerPackageId?: string;
  title: string;
  description: string;
  kind?: WidgetKind;
  defaultSlot?: UiSlot;
  supportedSlots?: readonly UiSlot[];
  defaultVisible?: boolean;
  requiredVisible?: boolean;
  /**
   * Marks this widget as a contributor to the status bar's minimal activity
   * strip (the `statusBar: "workflows"` mode): a slim bar that appears only
   * while this widget has something to say. The host renders strip widgets
   * bare in the two status-bar areas — no cluster or placement chrome — and
   * passes `context.strip = true`, so the contribution owns the strip frame
   * and simply returns nothing when it has no live content to show.
   */
  statusbarStrip?: boolean;
  /**
   * The widget acts on the agent's turn (a goal, approvals, workflows, voice
   * with the agent). A composer that writes only to people — a conversation,
   * or a chat the reader may only view — passes `context.agentless = true`
   * and the host leaves such widgets out.
   */
  agentOnly?: boolean;
  order?: number;
  category?: string;
  capabilities?: readonly string[];
  zone?: WidgetZone;
  supportedZones?: readonly WidgetZone[];
  recommendedSize?: WidgetSize;
  defaultSize?: WidgetSize;
  minSize?: WidgetSize;
  maxSize?: WidgetSize;
  audience?: WidgetAudience;
  showIn?: readonly WidgetAudience[];
  scope?: WidgetScope;
  resizable?: boolean;
  duplicatable?: boolean;
  floating?: boolean;
  recommended?: boolean;
  /** Semantic sizes supported when this widget is rendered in Workspace panel chrome. */
  panelSizes?: readonly PanelItemSize[];
  panelDefaultSize?: PanelItemSize;
  panelTitle?: string;
  settingsSchema?: Readonly<Record<string, unknown>>;
  /** Whether the widget has anything to show in this context (for example a
   *  session widget with no active session). Hosts that own the widget chrome
   *  omit the whole instance while this is false — outside edit mode, where the
   *  user must still be able to move or remove it. */
  isAvailable?: (context: WidgetAvailabilityContext) => boolean;
  render: (context: WidgetRenderContext) => ReactNode;
  settingsRender?: (context: WidgetSettingsContext) => ReactNode;
}

export interface WidgetPlugin {
  /** Semantic widget group id used by Widget Library grouping/filtering. */
  id: string;
  name: string;
  widgets?: readonly WidgetDefinition[];
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
}

export interface SurfaceContext {
  changeCount: number;
  eventCount: number;
  totalTokens: number;
  hasSession: boolean;
}

export interface SurfaceComponentProps {
  active?: boolean;
  /** Canonical shell-owned workspace scope. Package surfaces must prefer these
   * ids over importing or reconstructing navigation state themselves. */
  projectId?: string | null;
  sessionId?: string | null;
  /** What the window was last asked to show, as passed to
   *  `openWorkspacePane(id, resource)` (for example a catalog entry id); null
   *  when it was opened without one. Presentation only, never persisted. */
  resource?: string | null;
  /** Grows on every `openWorkspacePane(id, resource)` request, so asking for
   *  the same resource again (after the person navigated away inside the
   *  window) still reaches the content. */
  resourceSeq?: number;
}

/** Props of a package page shown in place of Chat. */
export interface PageComponentProps {
  /** What the page shows (an agent id), as passed to `openPage`; null for
   * the page's own home. */
  resource: string | null;
  /** Canonical workspace project while the page is open. */
  projectId: string | null;
}

/** A package page: content that takes Chat's place in the main canvas, the
 * way a chat opens from the navigator (an agent's own screen). The host owns
 * the canvas, navigation in and out and failure isolation; the page owns
 * everything inside it, its header included. Opening a chat, starting a new
 * one or switching project returns the canvas to Chat. */
export interface PageDefinition {
  id: string;
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
  /** Accessible name of the canvas while the page is shown. */
  title: string;
  component: (props: PageComponentProps) => ReactNode;
}

/** The page shown in place of Chat, if any. */
export interface ActivePageSnapshot {
  pageId: string;
  resource: string | null;
}

export type WorkspacePaneDock = "side" | "bottom";

export interface SurfacePresentation {
  kind: "workspace";
  defaultRatio: number;
  minWidth: number;
  minHeight?: number;
  preferredMaxWidth: number;
  keepAlive: boolean;
  escape: "close" | "content";
  /** Which edge a PINNED pane attaches to. Optional; omitted means "side"
   *  (docks beside Chat with a vertical resize). "bottom" makes the pinned
   *  pane a full-width strip under the workspace, so Chat's composer sits
   *  directly above it, with a horizontal resize on the top edge. Only the
   *  pinned window mode is affected — dynamic and fullscreen are unchanged. */
  dock?: WorkspacePaneDock;
  /** Edges supported by the pinned window. When omitted, the package exposes
   *  only its default `dock` edge (or the classic side edge). */
  dockOptions?: readonly WorkspacePaneDock[];
}

// ---- Workbench -----------------------------------------------------------------
// Profile-driven layout of one workbench: semantic regions (never left/right),
// per-surface presentation, and a public profile registry. Packages contribute
// profiles and placement constraints; they never own global geometry.

export type WorkbenchRegion = "start" | "primary" | "end" | "bottom";
export const WORKBENCH_REGIONS: readonly WorkbenchRegion[] = ["start", "primary", "end", "bottom"];
export type WorkbenchPresentation = "docked" | "floating" | "fullscreen";

export interface WorkbenchSurfacePlacement {
  preferredRegion?: WorkbenchRegion;
  allowedRegions?: readonly WorkbenchRegion[];
  minInlineSize?: number;
  minBlockSize?: number;
  keepAlive?: boolean;
}

export interface WorkbenchLayoutTemplateEntry {
  surface: string;
  region: WorkbenchRegion;
  presentation?: WorkbenchPresentation;
  active?: boolean;
}

export interface WorkbenchLayoutTemplate {
  surfaces: readonly WorkbenchLayoutTemplateEntry[];
  sizes?: Partial<Record<WorkbenchRegion, number>>;
  collapsed?: readonly WorkbenchRegion[];
}

/** Typed focused-split hints a profile may put in `presentation` beside
 *  `focused`/`splitSurfaces`. They are preferences, not geometry: the host
 *  validates them as untrusted data, clamps them and owns every pixel. */
export interface WorkbenchFocusedSplitHints {
  /** Chat as a companion of comfortable fixed width (CSS px): the work surface
   *  becomes the flexible primary column. Host floor for `min` is 360. */
  companionWidth?: { min: number; target: number; max: number };
  /** Below this viewport width (CSS px) the wide shell shows the session
   *  sidebar as its project rail while the profile is active. Automatic and
   *  never written to the user's sidebar preference. */
  sidebarRailBelow?: number;
}

/** Typed hints the Files surface reads from the active profile. */
export interface WorkbenchFilesHints {
  /** Keep every file the active chat edited open as a Files tab (each chat
   *  has its own set), open new edits as they land and reload clean editors
   *  an agent changed on disk. On unless a profile sets it to `false`. */
  openSessionEdits?: boolean;
}

/** Typed shell hints. Like every presentation hint they are preferences: the
 *  host decides when they apply (the wide shell) and owns every pixel. */
export interface WorkbenchShellHints {
  /** Lay the wide shell out mirrored while the profile is active: sidebar
   *  and project rail at the end edge, launcher strip and docked windows at
   *  the start edge, with radii, resize handles and window motion mirrored.
   *  Content keeps the document direction. Legacy `sidebarSide: "end"` means
   *  the same. */
  mirrored?: boolean;
}

export interface WorkbenchProfileDefinition {
  id: string;
  label: string;
  description: string;
  order: number;
  available?: () => boolean;
  defaultLayout: WorkbenchLayoutTemplate;
  /** Presentation hints (e.g. `{ text: "prose" }`, `WorkbenchFocusedSplitHints`,
   *  `WorkbenchFilesHints`, `WorkbenchShellHints`). Never geometry: size hints
   *  are preferences the host clamps. */
  presentation?: Readonly<Record<string, unknown> & WorkbenchFocusedSplitHints & WorkbenchFilesHints & WorkbenchShellHints>;
  /** Give this profile its own chat lane. New chats started in the profile
   *  are created with this session `purpose`; only sessions with the same
   *  purpose open in it (the host routes any other session to its own
   *  profile), and its sessions stay out of other profiles' session lists. */
  sessionPurpose?: string;
  /** Host-bound owner package id. Package callers should omit this; the
   *  activation scope stamps it and the host remembers it for the purpose
   *  lane even after the profile unregisters (a disabled package's chats). */
  ownerPackageId?: string;
}

export interface WorkbenchProfileSummary {
  id: string;
  label: string;
  description: string;
  order: number;
  available: boolean;
  presentation: Readonly<Record<string, unknown>>;
  sessionPurpose?: string;
  /** Owner package of this profile's package contributions, host-stamped. */
  ownerPackageId?: string;
}

export interface WorkbenchRegionSnapshot {
  surfaces: readonly string[];
  active: string | null;
  collapsed: boolean;
}

export interface WorkbenchSnapshot {
  activeProfile: string;
  profiles: readonly WorkbenchProfileSummary[];
  regions: Readonly<Record<WorkbenchRegion, WorkbenchRegionSnapshot>>;
  floating: readonly string[];
  fullscreen: string | null;
}

export interface OpenSurfaceOptions {
  region?: WorkbenchRegion;
  presentation?: WorkbenchPresentation;
  activate?: boolean;
}

export interface SurfaceDefinition {
  id: string;
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
  title: string;
  /** One-line purpose shown under the title in the shared module header. */
  description?: string;
  shortLabel?: string;
  icon?: () => ReactNode;
  capabilityId?: string;
  order: number;
  /** React always supplies a props object; an optional parameter here makes
   *  `createElement(component, { projectId })` infer empty props and reject it. */
  component: (props: SurfaceComponentProps) => ReactNode;
  badge?: (context: SurfaceContext) => number;
  visible?: (context: SurfaceContext) => boolean;
  /** Required package-window capabilities. The host owns all resulting chrome. */
  presentation: SurfacePresentation;
  /** Workbench placement constraints. Packages declare where their surface
   *  may live; they never own global geometry. */
  placement?: WorkbenchSurfacePlacement;
}

// ---- Resources --------------------------------------------------------------------
// Resource identity/data ≠ view/editor ≠ workbench placement.
// The document contract is pull-based: keystrokes must not require
// materializing the full buffer into this snapshot.

export interface ResourceRef {
  scheme: string;
  locator: string;
  projectId: string;
  sessionId: string | null;
  repositoryId?: string;
}

export interface ResourceSelection {
  startLine: number;
  endLine?: number;
  column?: number;
}

/** Host folder picker shared by package-owned management flows. */
export interface WebWorkspaceSurfaceHeaderProps {
  scope?: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  label?: string;
}

export interface WebFolderPickerProps {
  onClose(): void;
  onChoose(path: string): Promise<void>;
  title?: string;
  subtitle?: string;
  initialPath?: string;
  confirmLabel?: string;
}

export interface WebResourceLinkProps {
  resource: ResourceRef;
  children?: ReactNode;
  alias?: string;
  mode?: "compact" | "qualified" | "location" | "range";
  selection?: ResourceSelection;
  resolve?: boolean;
}

export type ResourceKind = "text" | "binary" | "unknown";

export interface ResourceDescriptor {
  label: string;
  kind: ResourceKind;
  mediaType?: string;
  language?: string;
  readOnly?: boolean;
  metadata?: Readonly<JsonObject>;
}

export interface ResourceContent {
  content: string;
  revision?: string;
  truncated?: boolean;
  tooLarge?: boolean;
  binary?: boolean;
}

export interface ResourceWriteResult {
  revision?: string;
}

export type ResourceStat =
  | { kind: "present"; revision?: string }
  | { kind: "missing" };

export interface ResourceProvider {
  scheme: string;
  describe(ref: ResourceRef): ResourceDescriptor;
  /** `opts.editable` means the caller will hold the result in a saveable
   *  buffer, so the provider must serve complete contents rather than a
   *  cheaper preview slice. Providers that never abbreviate ignore it. */
  read(ref: ResourceRef, opts?: { editable?: boolean }): Promise<ResourceContent>;
  write?(ref: ResourceRef, content: string, baseRevision?: string): Promise<ResourceWriteResult>;
  rename?(ref: ResourceRef, to: string): Promise<ResourceRef>;
  remove?(ref: ResourceRef): Promise<void>;
  stat?(ref: ResourceRef): Promise<ResourceStat>;
  subscribe?(ref: ResourceRef, listener: () => void): Unregister;
  rawUrl?(ref: ResourceRef): string;
}

export type ResourceDocumentStatus = "idle" | "loading" | "ready" | "error";
export type ResourceLiveKind =
  | "clean" | "dirty" | "saving" | "saved" | "external-change" | "conflict" | "deleted" | "check-failed";

export interface ResourceDocumentSnapshot {
  status: ResourceDocumentStatus;
  /** Last authoritative (saved) text. Not updated on keystrokes. */
  saved: string;
  revision?: string;
  dirty: boolean;
  readOnly: boolean;
  truncated: boolean;
  binary: boolean;
  live: { kind: ResourceLiveKind; noticeDismissed: boolean; message?: string } | null;
  error: string;
  composing: boolean;
  saveCount: number;
  /** Incremented on load, discard, and reload — invalidates retained editor state. */
  authoritativeGeneration: number;
}

/** Live editor (or other view) that owns the unsaved text without copying it
 *  into the document snapshot on every keystroke. */
export interface ResourceTextSource {
  getText(): string;
}

export interface ResourceDocumentHandle {
  key: string;
  ref: ResourceRef;
  getSnapshot(): ResourceDocumentSnapshot;
  subscribe(listener: () => void): Unregister;
  /** Materialize current text. Call on save/preview/chat-insert, not per keystroke. */
  getBuffer(): string;
  attachSource(source: ResourceTextSource): Unregister | null;
  /** User edited the attached source. First dirty transition notifies React. */
  markUserEdit(): void;
  /** Report edit equivalence to saved baseline without serializing on each keystroke. */
  reportUserEdit(equivalentToSaved: boolean): void;
  load(): Promise<void>;
  setComposing(composing: boolean): void;
  save(options?: { force?: boolean }): Promise<void>;
  reload(): Promise<void>;
  check(): Promise<void>;
  discard(): void | Promise<void>;
  dismissNotice(): void;
  autosaveDelay(enabled: boolean, delayMs?: number): number | null;
  moveTo(ref: ResourceRef): void | Promise<void>;
}

export { compactResourcePath } from "./resourcePath.ts";

/** Drag references carry identity; receiving surfaces resolve current authorized content. */
export type ResourceDragContext =
  | { kind: "working-changes"; staged?: boolean; snapshotDigest?: string; hunkDigest?: string }
  | { kind: "directory" };
export interface ResourceDragOptions {
  selection?: ResourceSelection;
  context?: ResourceDragContext;
}

export interface OpenResourceOptions {
  selection?: ResourceSelection;
  /** File opens use a replaceable preview unless explicitly pinned. */
  preview?: boolean;
}

export interface CapabilityDefinition {
  id: string;
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
  label: string;
  plainDescription: string;
  technicalLabel?: string;
  keywords: string[];
  standardTier: CapabilityTier;
  /** Where this capability sat by default before `standardTier` changed. A
   * project that already saw it and never placed it explicitly was showing it
   * there, so it keeps that tier (`recordCapabilityArrivals`). */
  legacyStandardTier?: CapabilityTier;
  standardRank: number;
  /** False keeps an internal destination searchable without a rail launcher,
   * even when a saved placement assigns it to a visible tier. Defaults true. */
  rail?: boolean;
  /** False when the owning package registers its own placeable widget, so the
   * host does not generate a second `capability:<id>` launcher. Defaults true. */
  launcherWidget?: boolean;
  /** `command` launchers act on a press (run something) instead of opening a
   * destination: they may live on any rail without a pane, never show as
   * active, never close an open pane, and each is its own launcher instead of
   * sharing its package's one rail slot. Defaults to `destination`. */
  kind?: CapabilityKind;
  /** The launcher's own monochrome mark, drawn with the rail's `size` and
   * `strokeWidth`. Defaults to the owning package's mark. */
  icon?: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  open: () => void;
  available: () => boolean;
  unavailableReason?: () => string | null;
}

export type CapabilityKind = "destination" | "command";

/** What a tool call does, in the host's classification. Speech and status
 *  lines use it to say "reading config.ts" instead of a raw tool name. */
export type ToolActivityKind =
  | "shell" | "read" | "edit" | "write" | "create" | "delete" | "move" | "search" | "web"
  | "browser" | "mcp" | "subagent" | "test" | "git" | "plan" | "tool";

export interface ToolActivityDescription {
  kind: ToolActivityKind;
  /** A short, speakable subject: a file name, program, query, site or tool
   *  title; never a full path, command line or file content. */
  target?: string;
}

export interface SettingsSearchItem {
  id: string;
  pageId: string;
  label: string;
  description?: string;
  keywords?: string[];
  focusTarget: string;
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
}

/** Optional target within a settings page. Page owners interpret the fields
 * they support; the host only carries the target through navigation. */
export interface SettingsNavigationTarget {
  itemId?: string;
  sectionId?: string;
}

export interface SettingsPageRedirect {
  pageId: string;
  target?: SettingsNavigationTarget;
}

export type SettingsPageGroup = "Workspace" | "Engineering" | "Customize" | "System";

export interface ProjectContextItem {
  label: string;
  value: string;
}

export interface ProjectContextSnapshot {
  title: string;
  items?: readonly ProjectContextItem[];
  recommendedWidgetIds?: readonly string[];
  needsSetup?: {
    label: string;
    open(): void;
  };
}

export interface ProjectContextContribution {
  /** Semantic contribution id. Owner package identity is host-bound. */
  id: string;
  order?: number;
  getSnapshot(projectId: string): ProjectContextSnapshot | null;
  subscribe?(listener: () => void): Unregister;
}

/** Narrow, project-labelled contribution shown by the host's project settings
 * dialog. Feature packages own the page content; the host owns the menu,
 * dialog chrome, focus and mobile navigation. */
export interface ProjectSettingsContribution {
  id: string;
  order?: number;
  label: string;
  description?: string;
  icon?: string;
  visible?: (projectId: string) => boolean;
  render(context: {
    projectId: string;
    project: Readonly<Project>;
    mobile: boolean;
    stage: "menu" | "page";
    open(): void;
    onBack(): void;
    onClose(): void;
  }): ReactNode;
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
}

export interface SettingsPageDefinition {
  /** Semantic settings route id (for example `voice`). */
  id: string;
  /**
   * Owner package id. Optional for package callers — the activation scope
   * binds it. Do not use this as the settings route id.
   */
  packageId?: string;
  label: string;
  group: SettingsPageGroup;
  icon?: string;
  order?: number;
  /** Keep compatibility aliases addressable without showing another nav row. */
  nav?: boolean;
  redirect?: SettingsPageRedirect;
  component: ComponentType<{ settingsTarget?: SettingsNavigationTarget }>;
  settingsItems?: SettingsSearchItem[];
}

export interface WebStoreSnapshot {
  activeProjectId: string | null;
  activeSessionId: string | null;
  activeView: string;
  overlay: string | null;
  railPlugin: string | null;
  /** Active workbench profile id ("conversation" by default). */
  workbenchProfile: string;
  settings: Readonly<Record<string, unknown>>;
  /** The package page shown in place of Chat. While it is set no chat is on
   * screen, even though `activeSessionId` still names the one Chat returns
   * to. Absent on older hosts. */
  activePage?: ActivePageSnapshot | null;
}

export type WebEventReducer<State = unknown> = (
  state: State,
  event: SessionEvent,
) => void;

export interface WebDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  backdropClassName?: string;
  size?: "md" | "lg" | "full";
  initialFocus?: string;
  resolveRestoreFocus?: (opener: HTMLElement | null) => HTMLElement | null;
  ariaDescribedBy?: string;
}

/** One dictation run streaming into the composer draft. `text` is always the
 * run's cumulative transcript; `final` releases the run's span. `discard`
 * removes the run's words from the draft (a spoken command, not a message). */
export interface ComposerDictationUpdate {
  runId: string;
  text: string;
  final: boolean;
  discard?: boolean;
}

export interface HandoffTargetInput {
  projectId: string;
  sessionId?: string | null;
  text: string;
}

/**
 * Bounded context the host gives a package-owned composer contribution. A
 * contribution never reaches into the shell store or composer event bus: it
 * reads the current draft context and asks the host to open its own dialog,
 * insert text, or report a failure.
 */
export interface ComposerContributionContext {
  projectId: string | null;
  sessionId: string | null;
  /** Current draft text snapshot at activation/paste time. */
  draftText: string;
  /** Mount a package-owned inline panel or dialog. The render function
   *  receives `close`; the returned function closes it too (idempotent). */
  openDialog(render: (close: () => void) => ReactNode): () => void;
  /** Close every dialog this contribution currently has open. */
  close(): void;
  /** Insert plain text into the composer draft at the caret (never sends). */
  insertText(text: string): void;
  /** Host-owned transient error notice. */
  error(message: string, action?: WebErrorAction): void;
  /** Enter a registered composer mode (`null` leaves the current one). An
   *  unavailable or unknown mode is ignored. Optional for older hosts. */
  setMode?(modeId: string | null): void;
}

/**
 * One composer mode: while it is on, the host composer shows the mode's chip,
 * placeholder and submit label, and Enter/Send hand the draft text to
 * `submit` instead of the session. A mode submission is never queued, steered
 * or blocked by a running turn and never creates a session. The host owns the
 * chip, the focus and the leave gestures (× on the chip, Esc in an empty
 * draft, Backspace at the start of an empty draft); a session change leaves
 * the mode. A composer that writes only to people never offers modes.
 */
export interface ComposerMode {
  id: string;
  /** Chip label; resolved on every render so a locale switch stays live. */
  label: string | (() => string);
  /** Typed at the very start of the draft and followed by a space (e.g.
   *  `/btw`), it enters the mode and is removed from the draft. */
  trigger?: string;
  placeholder?: string | (() => string);
  /** Send control label while the mode is on, e.g. "Ask". */
  submitLabel?: string | (() => string);
  /** Chip glyph. */
  icon?: () => ReactNode;
  /** False keeps the mode off in this context (and leaves it if it is on). */
  isAvailable?(context: ComposerContributionContext): boolean;
  /** Receives the trimmed draft. The host clears the draft once this resolves
   *  and keeps it when it throws or rejects; the mode stays on either way. */
  submit(context: ComposerContributionContext, text: string): void | Promise<void>;
}

/** One composer Add-menu contribution. The host owns menu chrome, roles, focus
 *  and ordering; the package owns the label, activation and any dialog. */
export interface ComposerAddMenuItem {
  id: string;
  /** Resolved on every render so a locale switch stays live. */
  label: string | (() => string);
  /** Compact label kept for older hosts. The Add menu now shows a contribution
   *  once, as a full labelled row, so current hosts do not read it. */
  shortLabel?: string | (() => string);
  description?: string | (() => string);
  /** Host icon renderer, drawn at the start of the menu row. */
  icon?: () => ReactNode;
  /** Ascending order after the built-in mention row. */
  order?: number;
  /** False hides the item in this context (never a disabled label). */
  isAvailable?(context: ComposerContributionContext): boolean;
  activate(context: ComposerContributionContext): void;
}

/** One composer paste handler. Handlers are offered pasted text before the
 *  default paste; returning true consumes it. */
export interface ComposerPasteHandler {
  id: string;
  match(text: string): boolean;
  handle(context: ComposerContributionContext, text: string): Promise<boolean>;
}

/** Context for an "after new session created" composer hook: the host has just
 *  created `sessionId` for `projectId` for the composer's first message
 *  `text`. This is a post-creation step, not a send: the message is delivered
 *  only after every hook resolves. */
export interface ComposerSessionCreatedContext {
  projectId: string;
  sessionId: string;
  /** The first message text the composer is about to send. */
  text: string;
}

/** One composer "after new session created" hook. The host awaits every
 *  registered hook in registration order before it delivers the first message,
 *  and a rejection aborts the send the same way it always has. */
export interface ComposerSessionCreatedHook {
  id: string;
  run(context: ComposerSessionCreatedContext): Promise<void>;
}

export interface HandoffTargetRegistration {
  id: "current-session" | "queue" | "new-session" | "draft";
  label: string;
  available(): boolean;
  send(input: HandoffTargetInput): Promise<void>;
}

/**
 * Shared host primitives exposed to feature packages. Individual components
 * retain their concrete props in the shell; packages pass their known props
 * through this bounded component handle.
 */
export type WebUiComponent<Props extends object = Record<string, unknown>> = ComponentType<Props>;
/** A glyph a control draws: an `iconSet` component or a legacy `icons` mark. */
export type WebGlyph = WebIconComponent | (() => ReactNode);
/** The host `Button`: every native button attribute plus the shared look. */
export interface WebButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  children?: ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "ghost" | "quiet" | "danger";
  busy?: boolean;
  /** Full-width in its container. */
  block?: boolean;
  iconStart?: WebGlyph;
  iconEnd?: WebGlyph;
}
/** The host `IconButton`: a glyph-only button whose `label` is its name. */
export interface WebIconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children" | "aria-label"> {
  icon: WebGlyph;
  label: string;
  variant?: "quiet" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  busy?: boolean;
  /** Toggle state (sets aria-pressed). */
  pressed?: boolean;
}
export interface WebTextareaProps extends ComponentPropsWithRef<"textarea"> {
  invalid?: boolean;
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
}
export interface WebCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}
export interface WebTabItem { id: string; label: ReactNode; disabled?: boolean }
export interface WebTabsProps {
  tabs: readonly WebTabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Ids for `TabPanel` (see `host.ui.tabIds`). */
  idBase?: string;
  size?: "sm" | "md";
  className?: string;
}
export interface WebSelectProps {
  label: string;
  value?: string;
  options: readonly WebSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  mobileSheet?: boolean;
  searchable?: boolean;
  align?: "start" | "center" | "end";
}
/** What a `Menu` hands its trigger: spread it on the opening button. */
export interface WebMenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-haspopup": "menu" | "dialog";
  "aria-expanded": boolean;
}
export interface WebMenuProps {
  /** Accessible name; also the phone-sheet title unless `title` is set. */
  label: string;
  title?: string;
  entries: readonly WebMenuEntry[];
  children: (trigger: WebMenuTriggerProps) => ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
  phonePresentation?: "sheet" | "popover";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  anchorRef?: RefObject<HTMLElement | null>;
  header?: ReactNode;
  footer?: ReactNode;
  renderContent?: (context: { close: () => void; sheet: boolean }) => ReactNode;
}
/** The host `TextInput`: every native input attribute (id, ref, aria-*,
 *  enterKeyHint, autoCapitalize…) plus the shared invalid state and size. */
export interface WebInputProps extends Omit<ComponentPropsWithRef<"input">, "size"> {
  /** Visual + accessible invalid state (sets aria-invalid). */
  invalid?: boolean;
  uiSize?: "sm" | "md";
}
export interface WebEmptyStateProps { title: string; description?: string; actionLabel?: string; onAction?: () => void; variant?: "page" | "panel" | "compact"; }

/** A host action glyph (the curated Lucide set): sized by `size` in px or the
 *  surrounding control, coloured by `currentColor`. */
export interface WebIconGlyphProps {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}
export type WebIconComponent = (props: WebIconGlyphProps) => ReactNode;

/** The legacy domain marks every host carries in `host.ui.icons` (15px line
 *  glyphs). Other keys may exist on newer hosts; read those as optional. */
export const WEB_LEGACY_ICON_NAMES = [
  "workflow", "gear", "palette", "chat", "coach", "bell", "keyboard", "widgets", "package", "plug", "link",
  "home", "puzzle", "plus", "question", "search", "tree", "files", "globe", "context", "usage", "compare",
  "fuse", "term", "events", "clock", "paperclip", "focus", "send", "stop", "github", "gitlab", "mic",
  "speaker", "book", "pencil", "shield", "copy", "markdown", "json", "fork", "rewind", "check", "select",
  "list", "hierarchy", "filter", "sort", "target", "sync", "fetch", "pull", "push", "shuffle", "branch",
  "worktree", "pullRequest", "stage", "unstage", "trash", "discard", "close", "chevronDown", "chevronUp",
  "chevronRight", "back", "commit", "session", "more", "external", "refresh", "sliders", "image", "bookmark",
  "pin", "regenerate", "fileEdit", "text", "download", "brain", "plan", "newSession", "multirun", "video",
  "file",
] as const;
export type WebLegacyIconName = (typeof WEB_LEGACY_ICON_NAMES)[number];
export type WebLegacyIcons = Readonly<Record<WebLegacyIconName, () => ReactNode>> & Readonly<Record<string, (() => ReactNode) | undefined>>;

/** Action glyphs the host promises to packages (`host.ui.iconSet`). One action
 *  always uses one glyph, so packages pick from here instead of drawing their
 *  own. `FitIcon` frames the whole image (a viewer's "fit to screen"). */
export const WEB_ICON_NAMES = [
  "AddIcon", "ArchiveIcon", "AttachmentIcon", "BackIcon", "BoardViewIcon", "ChatIcon",
  "CheckIcon", "ChevronDownIcon", "ChevronLeftIcon", "ChevronRightIcon", "ChevronUpIcon", "CloseIcon",
  "CopyIcon", "DeleteIcon", "DockSideIcon", "DownloadIcon", "EditIcon", "ExternalLinkIcon", "FileIcon",
  "FilterIcon", "FitIcon", "ImageIcon", "LayersIcon", "LinkIcon", "ListViewIcon", "MinusIcon", "MoreIcon",
  "NewChatIcon", "PlusIcon", "RefreshIcon", "SearchIcon", "SendIcon", "SettingsIcon", "SharedIcon",
  "TasksIcon", "UploadIcon", "ViewOptionsIcon", "ZoomInIcon", "ZoomOutIcon",
] as const;
export type WebIconName = (typeof WEB_ICON_NAMES)[number];
export type WebIconSet = Readonly<Record<WebIconName, WebIconComponent>>;

/** The design-system dialog: header with title and close, a scrolling body
 *  and an action row pinned under it (`footer`). `ui.Dialog` stays the bare
 *  modal engine for surfaces that draw their own frame. */
export interface WebFramedDialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Action row pinned under the body (Buttons, usually end-aligned). */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "full";
  className?: string;
  initialFocus?: string;
  /** Hide the visible header when the content owns its heading. */
  hideHeader?: boolean;
  resolveRestoreFocus?: (opener: HTMLElement | null) => HTMLElement | null;
  ariaDescribedBy?: string;
}

export interface WebSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name; required unless an external <label> is wired. */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
}

export interface WebSpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Accessible status text (e.g. "Loading boards"). */
  label?: string;
  className?: string;
}

export interface WebBadgeProps {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
  children: ReactNode;
  /** Leading status dot. */
  dot?: boolean;
  className?: string;
}

export interface WebNoticeProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  tone?: "error" | "warning" | "success" | "info";
  heading?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  icon?: ReactNode;
  iconPosition?: "leading" | "trailing";
}

export interface WebSkeletonProps {
  shape?: "text" | "block" | "circle";
  width?: string | number;
  height?: string | number;
  className?: string;
}

/** The panel a `Tabs` tab controls; ids come from `ui.tabIds`. */
export interface WebTabPanelProps {
  idBase: string;
  tabId: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}

/** A glyph from `iconSet` at a token size step (18px control glyph default). */
export interface WebIconProps {
  icon: WebIconComponent;
  size?: "sm" | "md" | "lg" | "xl";
  /** Accessible name. Omit for decorative icons (they become aria-hidden). */
  label?: string;
  className?: string;
}

export interface WebMenuAction {
  id: string;
  label: string;
  icon?: WebIconComponent | (() => ReactNode);
  detail?: string;
  danger?: boolean;
  disabled?: boolean;
  kind?: "action" | "radio" | "checkbox" | "switch";
  checked?: boolean;
  /** Small color dot for label-style entries (a literal color is data). */
  swatch?: string;
  keywords?: readonly string[];
  /** Drill-in list opened in place of the menu; `onSelect` is not called. */
  entries?: readonly WebMenuEntry[];
  value?: string;
  onSelect: () => void;
}
export type WebMenuEntry = WebMenuAction | { heading: string } | "separator";

export interface WebSelectOption { value: string; label: string; group?: string; detail?: string }

export interface WebPickerItem { id: string; label: string; group: string; detail?: string; keywords?: readonly string[] }

/** The host's searchable chip picker (single or multi-select). */
export interface WebPickerProps {
  label: string;
  items: WebPickerItem[];
  value?: string;
  /** Multi-select mode: toggles stay open, the chip shows a count. */
  values?: readonly string[];
  onPick: (id: string) => void;
  onOpen?: () => void;
  placeholder?: string;
  searchPlaceholder?: string;
  direction?: "up" | "down";
  disabled?: boolean;
  searchable?: boolean;
  align?: "start" | "center" | "end";
  className?: string;
  popoverClassName?: string;
  ariaLabel?: string;
  triggerIcon?: ReactNode;
  displayValue?: ReactNode;
  itemIcon?: (item: WebPickerItem) => ReactNode;
  emptyMessage?: string;
  emptyAction?: { label: string; run: () => void };
  footerAction?: { label: string; run: () => void; stayOpen?: boolean; disabledReason?: string };
  mobileSheet?: boolean;
}

/** One labelled setting row of a settings page (`SettingsSection` child). */
export interface WebSettingsRowProps {
  label?: ReactNode;
  hint?: ReactNode;
  /** Stable id for settings search / reveal. */
  itemId?: string;
  children: ReactNode;
  layout?: "inline" | "stacked";
  top?: boolean;
  /** Dims the copy; the control itself must still be disabled by the page. */
  disabled?: boolean;
}

/** A titled group of settings rows, laid out like the host Settings window. */
export interface WebSettingsSectionProps {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  itemId?: string;
  tone?: "danger";
  children: ReactNode;
}

/** One item of the host media viewer. A missing or `image/*` mime shows an
 *  image; video, audio, PDF and text render inline; anything else is a card
 *  with a download action. */
export interface WebMediaItem {
  id: string;
  name: string;
  url: string;
  mime?: string;
}

/** The host full-screen media viewer: swipe/arrow paging, pinch/wheel/double
 *  tap zoom, pull to dismiss, the thumbnail strip and glass chrome. Packages
 *  extend it instead of copying it. */
export interface WebMediaViewerProps {
  items: readonly WebMediaItem[];
  /** First item shown when the viewer manages its own position. */
  start?: number;
  /** Controlled position; pair with `onIndexChange`. */
  index?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  /** Drawn over the shown image, inside the zoomed frame and sized to the
   *  rendered image box, so percentage coordinates land on image pixels. */
  renderOverlay?: (item: WebMediaItem, index: number) => ReactNode;
  /** A package panel beside the stage (below it on phones). */
  aside?: ReactNode;
  /** Accessible name of the aside region. */
  asideLabel?: string;
  /** Package controls in a row under the stage (tools, toggles). */
  actions?: ReactNode;
  /** Suspend zoom, paging and pull-to-dismiss gestures (e.g. while the
   *  person draws on the overlay). Buttons, keys and the strip still work. */
  gesturesDisabled?: boolean;
  className?: string;
}

export interface ConversationSeed {
  title?: string;
  draft?: string;
  /** Existing validated checkout; session creation still waits for first send. */
  worktreePath?: string;
  repositoryIds?: string[];
  /** Preselect a managed isolated workspace, created only on first send. */
  isolate?: boolean;
}

export interface WebErrorAction {
  label: string;
  run(): void | Promise<void>;
}

/** What a transient notification is about. The kind picks its glyph, tone,
 *  default lifetime and whether the stack announces it assertively (`error`)
 *  or politely (everything else). */
export type WebNotificationKind =
  | "error"
  | "warning"
  | "success"
  | "info"
  | "progress"
  | "update"
  | "news"
  | "hint";

export type WebNotificationDismissReason = "user" | "timeout" | "programmatic" | "overflow";

export interface WebNotificationAction {
  label: string;
  run(): void | Promise<void>;
  /** The one emphasized action (at most one per notification). */
  primary?: boolean;
  /** A host `ui` icon component (e.g. `host.ui.components`' icon set). */
  icon?: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  /** Draw only the icon; `label` becomes its accessible name. */
  iconOnly?: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** Leave the notification open after the action runs (default: it closes). */
  keepOpen?: boolean;
}

/** One transient notification (`host.notifications.show`). */
export interface WebNotificationInput {
  /** Stable id: showing the same id again replaces that notification in place.
   *  A package's ids live in its own namespace; it can only reach its own. */
  id?: string;
  kind: WebNotificationKind;
  title: string;
  body?: ReactNode;
  /** A short monospace excerpt under the body (e.g. the last lines of output). */
  excerpt?: string;
  /** Replaces the kind's glyph (e.g. a package mark). */
  icon?: ReactNode;
  actions?: readonly WebNotificationAction[];
  /** 0..1 shows a determinate bar; `null` on a `progress` kind shows activity. */
  progress?: number | null;
  /** Lifetime in ms, or "sticky" to stay until dismissed. Defaults per kind. */
  duration?: number | "sticky";
  /** Whether the person can close it (button, swipe, Escape). Default true. */
  dismissible?: boolean;
  /** Accessible name of the close control (default "Dismiss notification"). */
  dismissLabel?: string;
  /** Extra `data-*` attributes on the card, for package styling hooks/tests.
   *  Keys must match `/^[a-z0-9-]+$/`; other keys are dropped. */
  data?: Readonly<Record<string, string>>;
  onDismiss?(reason: WebNotificationDismissReason): void;
}

export type WebNotificationPatch = Partial<Omit<WebNotificationInput, "id" | "kind">> & {
  kind?: WebNotificationKind;
};

export interface WebNotificationHandle {
  readonly id: string;
  update(patch: WebNotificationPatch): void;
  dismiss(): void;
}

/** A package-owned durable UI preference. The host validates JSON and mirrors
 * the value through the account settings transport; the package owns parsing,
 * local caching, and its subscription lifecycle. */
export interface WebUiPreferenceAdapter {
  read(): unknown;
  write(value: unknown): void;
  subscribe(listener: () => void): Unregister;
}

/** Where a fenced Markdown block renders. `blockKey` is stable for one block
 * of one message across re-renders and streaming, so it keys presentation-only
 * state (sort, selection); it is not a durable identifier. */
export interface MarkdownFenceContext {
  blockKey: string;
  projectId?: string;
  sessionId?: string | null;
  /** True only for an agent's answer in the conversation. Absent for files,
   *  issue and pull request text, user prompts and every other surface: a
   *  renderer that runs code must wait for a click there. */
  conversation?: boolean;
  /** In an agent's answer: the text of the first user message after that
   *  answer, once there is one. A renderer whose buttons send messages can
   *  recognise its own reply and show itself answered after a reload. It is
   *  canonical history, so it survives reloads; absent everywhere else. */
  reply?: string;
}

export interface MarkdownFenceRendererProps {
  /** The fence info-string language, lowercase. */
  lang: string;
  /** Fence body the package parses. When the opening line carries extra
   * info-string tokens after the language (e.g. `ui steps Plan`), the host
   * folds them in as the first line (`text` keeps that folding for older
   * renderers); `info` carries the same tokens separately. */
  text: string;
  /** The raw info string after the language (everything after the first
   * whitespace run on the opening fence line), or `""` when there is none.
   * When it is non-empty, `text` starts with exactly `info` + `"\n"` unless
   * the body is empty, in which case `text` is exactly `info`. Prefer this over
   * guessing from `text`; it is `undefined` on older hosts. */
  info?: string;
  /** False while the closing marker has not arrived (streaming). */
  closed: boolean;
  context: MarkdownFenceContext;
  /** The host's own code-block rendering of the same fence, for a
   * "show as text" toggle and as the package's invalid-input fallback. */
  source: ReactNode;
}

/** A package renderer for fenced Markdown blocks of the given languages. The
 * host keeps built-in fences (`mermaid`, `json`) and refuses a language
 * another package already owns. A renderer that throws falls back to `source`. */
export interface MarkdownFenceRegistration {
  languages: readonly string[];
  component: ComponentType<MarkdownFenceRendererProps>;
  ownerPackageId?: string;
}

/** A package's way to group the session lists. Pure functions of a session
 *  and the package's own state: the host draws the headings and rows. */
export interface SessionGroupingDefinition {
  /** Stable id; the person's choice is saved under it. */
  id: string;
  /** Shown in the "Group by" menu. */
  label: string;
  /** The group a session belongs to; one per session. */
  keyOf(session: SessionProjection): string;
  /** Heading for a key (the key itself when omitted); null draws none. */
  labelOf?(key: string): string | null;
  /** Group position, lower first (first appearance when omitted). */
  rankOf?(key: string): number;
  /** Called when the state behind keyOf changes, so the list re-sorts. */
  subscribe?(listener: () => void): Unregister;
}

export interface WebPackageHost {
  /** Markdown extension seams. Optional for older hosts. */
  markdown?: {
    registerFence(registration: MarkdownFenceRegistration): Unregister;
  };
  slots: {
    register(registration: SlotRegistration): Unregister;
    list(slot: UiSlot): Array<{ id: string; order: number; meta?: Readonly<Record<string, unknown>> }>;
  };
  widgets: {
    register(pluginId: string, definition: WidgetDefinition): Unregister;
    registerPlugin(plugin: WidgetPlugin): Unregister;
  };
  surfaces: {
    register(definition: SurfaceDefinition): Unregister;
    /** Whether a package window with this id is registered right now, so a
     *  package that only offers a way into another package's window renders
     *  no control while it is absent. Optional for older hosts; a missing
     *  answer means unknown. */
    has?(surfaceId: string): boolean;
  };
  /** Package pages shown in place of Chat. Optional for older hosts. */
  pages?: {
    register(definition: PageDefinition): Unregister;
    /** Whether a page with this id is registered right now. A package that
     *  merely offers a way in (for example "browse the catalog") asks first,
     *  so the control disappears with the page instead of doing nothing.
     *  Optional for older hosts; treat a missing answer as "unknown". */
    has?(pageId: string): boolean;
  };
  capabilities: {
    register(definition: CapabilityDefinition): Unregister;
    /** Re-render consumers when a registered capability's `available()`
     *  result changes without replacing the descriptor. */
    notify(): void;
    /** Where a registered capability sits in the active project: its
     *  resolved tier and whether it has a rail home. `null` if unknown.
     *  Optional for older hosts. */
    placement?(id: string): { tier: CapabilityTier; onRail: boolean } | null;
    /** Put a capability on the right rail (`more`), the top rail (`primary`)
     *  or take it off every rail (`technical`; it stays searchable). Acts on
     *  the active project's synced layout, like the rail editor. */
    place?(id: string, tier: CapabilityTier): void;
    /** Notified when any capability's placement may have changed. */
    subscribePlacement?(listener: () => void): Unregister;
  };
  settings: {
    registerPage(definition: SettingsPageDefinition): Unregister;
    registerItems(items: SettingsSearchItem[]): Unregister;
  };
  preferences: {
    register(id: string, adapter: WebUiPreferenceAdapter): Unregister;
  };
  /** Package onboarding tours shown by the shell's settings overlay. Optional
   *  for older hosts; package entries should feature-detect it. */
  onboarding?: {
    registerTour(tour: PackageOnboardingTour): Unregister;
  };
  projectSettings: {
    register(contribution: ProjectSettingsContribution): Unregister;
    list(projectId: string): readonly ProjectSettingsContribution[];
    subscribe(listener: () => void): Unregister;
    /** Open a project dialog at an optional registered contribution. */
    open?(projectId: string, contributionId?: string): void;
  };
  projectContext: {
    register(contribution: ProjectContextContribution): Unregister;
  };
  reducers: {
    register<State = unknown>(eventType: string, reducer: WebEventReducer<State>): Unregister;
  };
  store: {
    getSnapshot(): WebStoreSnapshot;
    subscribe(listener: () => void): Unregister;
    select<T>(selector: (snapshot: WebStoreSnapshot) => T): T;
  };
  executionDraft: {
    get(projectId: string): DraftExecutionConfig;
    update(projectId: string, patch: Partial<DraftExecutionConfig>): DraftExecutionConfig;
    clear(projectId: string): void;
    subscribe(listener: () => void): Unregister;
  };
  sessions: {
    upsert(session: SessionProjection): void;
    get(sessionId: string): SessionProjection | undefined;
    events(sessionId: string): readonly SessionEvent[];
    subscribe(listener: () => void): Unregister;
    /** Observe newly ingested canonical events. Events are delivered after
     * the host store accepts them and are never a substitute for durable
     * session history. Package UI uses this for presentation-only reactions
     * such as revealing a surface before a tool's permission/mutation. */
    subscribeEvents(listener: (event: SessionEvent) => void): Unregister;
    /** Present sessions of this `purpose` (and their delegated children) in
     *  the package's own UI instead of the ordinary session lists — for
     *  example an agent's runs, read from its diary. Opening such a session
     *  is unchanged. Optional for older hosts. */
    claimListing?(purpose: string): Unregister;
    /** Offer a way to group the session lists (their "Group by" menu).
     *  Optional for older hosts. */
    registerGrouping?(grouping: SessionGroupingDefinition): Unregister;
  };
  /** The host's reading of a tool call, as the timeline cards show it.
   *  Optional for older hosts; package entries should feature-detect it. */
  execution?: {
    describe(tool: string, input: Readonly<Record<string, unknown>>): ToolActivityDescription;
  };
  /** Canonical composer/session handoff. Package UI never reaches into the
   * shell store or composer event bus directly. */
  conversation: {
    insert(text: string): void;
    startNewSession(projectId: string, seed?: ConversationSeed): void;
    openSession(sessionId: string): Promise<void>;
    /** Reveal a visible canonical message, paging older history if needed.
     * False means the target could not be displayed. Optional for older hosts. */
    revealEvent?(sessionId: string, eventSeq: number, options?: {
      focus?: boolean;
      signal?: AbortSignal;
      /** Text inside the message to land on and light for a moment. The message
       *  alone is shown when the text is no longer in it. */
      passage?: string;
    }): Promise<boolean>;
    send(sessionId: string, text: string, options?: { delivery?: "normal" | "queue" | "interrupt" }): Promise<boolean>;
    /** Stream a spoken transcript into the mounted composer as a run-scoped
     * span (a draft, never a canonical turn). False when no composer took it.
     * Optional for older hosts. */
    dictate?(update: ComposerDictationUpdate): boolean;
    /** Send the mounted composer's draft exactly as its Send control would:
     * same target, new-session creation, model, attachments and follow-up
     * delivery. True means a composer accepted the request; admission is still
     * asynchronous and a refusal surfaces in that composer. Never queued for a
     * later composer. `delivery` chooses the follow-up mode while a turn runs
     * (the user's setting otherwise). Optional for older hosts. */
    submitDraft?(options?: { delivery?: "queue" | "steer" | "interrupt" }): boolean;
  };
  navigation: {
    setActiveView(view: string): void;
    openSettingsPage(pageId: string, target?: SettingsNavigationTarget): void;
    openWorkspacePane(surfaceId: string, resource?: string): boolean;
    closeWorkspacePane(): void;
    /** Show a registered page in place of Chat, as opening a chat from the
     * navigator does. `projectId` first switches the workspace to that
     * project. False when no such page is registered. Optional for older
     * hosts. */
    openPage?(pageId: string, resource?: string | null, options?: { projectId?: string }): boolean;
    /** Return the canvas to Chat. */
    closePage?(): void;
    openRailSurface(surfaceId: string): void;
    setOverlay(overlay: string | null): void;
    /** Canonical resource navigation: every file/artifact/diff open lands here. */
    openResource(ref: ResourceRef, options?: OpenResourceOptions): void;
    revealResource(ref: ResourceRef): void;
  };
  workbench: {
    profiles: {
      register(definition: WorkbenchProfileDefinition): Unregister;
      list(): readonly WorkbenchProfileSummary[];
    };
    activateProfile(profileId: string): boolean;
    getProfileSession(profileId: string): string | null | undefined;
    getActiveProfile(): WorkbenchProfileSummary;
    getSnapshot(): WorkbenchSnapshot;
    subscribe(listener: () => void): Unregister;
    openSurface(surfaceId: string, options?: OpenSurfaceOptions): boolean;
    closeSurface(surfaceId: string): void;
    moveSurface(surfaceId: string, region: WorkbenchRegion): boolean;
    swapSurfaces(surfaceId: string, otherSurfaceId: string): boolean;
    setPresentation(surfaceId: string, presentation: WorkbenchPresentation): boolean;
    resetProfileLayout(profileId?: string): void;
  };
  resources: {
    drag?(transfer: Pick<DataTransfer, "setData" | "getData">, resource: ResourceRef, options?: ResourceDragOptions): void;
    registerProvider(provider: ResourceProvider): Unregister;
    getProvider(scheme: string): ResourceProvider | undefined;
    describe(ref: ResourceRef): ResourceDescriptor | null;
    key(ref: ResourceRef): string;
    notifyMoved(from: ResourceRef, to: ResourceRef): void;
    notifyRemoved(ref: ResourceRef): void;
    documents: {
      open(ref: ResourceRef): ResourceDocumentHandle;
      isDirty(ref: ResourceRef): boolean;
      subscribe(listener: () => void): Unregister;
    };
  };
  ui: {
    icons: WebLegacyIcons;
    Dialog: ComponentType<WebDialogProps>;
    Slot: ComponentType<{ slot: UiSlot; context?: Record<string, unknown>; customizable?: boolean }>;
    components: Readonly<{
      Button: WebUiComponent<WebButtonProps>;
      IconButton: WebUiComponent<WebIconButtonProps>;
      Menu: WebUiComponent<WebMenuProps>;
      Tabs: WebUiComponent<WebTabsProps>;
      TextInput: WebUiComponent<WebInputProps>;
      Textarea: WebUiComponent<WebTextareaProps>;
      Checkbox: WebUiComponent<WebCheckboxProps>;
      Select: WebUiComponent<WebSelectProps>;
      EmptyState: WebUiComponent<WebEmptyStateProps>;
      MarkdownDoc: WebUiComponent<Record<string, unknown>>;
      FolderPicker?: WebUiComponent<WebFolderPickerProps>;
      ResourceLink?: WebUiComponent<WebResourceLinkProps>;
      WorkspaceSurfaceHeader?: WebUiComponent<WebWorkspaceSurfaceHeaderProps>;
      /** A row above the composer that grows in and folds away instead of
       *  popping the composer; it keeps its last content while it closes.
       *  Optional for older hosts. */
      ComposerNoticeRow?: WebUiComponent<{ open: boolean; children?: ReactNode }>;
      /** The framed dialog with a footer row. Optional for older hosts. */
      Dialog?: WebUiComponent<WebFramedDialogProps>;
      Switch?: WebUiComponent<WebSwitchProps>;
      Spinner?: WebUiComponent<WebSpinnerProps>;
      Badge?: WebUiComponent<WebBadgeProps>;
      Notice?: WebUiComponent<WebNoticeProps>;
      Skeleton?: WebUiComponent<WebSkeletonProps>;
      TabPanel?: WebUiComponent<WebTabPanelProps>;
      Icon?: WebUiComponent<WebIconProps>;
      Picker?: WebUiComponent<WebPickerProps>;
      SettingsRow?: WebUiComponent<WebSettingsRowProps>;
      SettingsSection?: WebUiComponent<WebSettingsSectionProps>;
      MediaViewer?: WebUiComponent<WebMediaViewerProps>;
    }>;
    /** Action glyph components (see `WEB_ICON_NAMES`). Optional for older
     *  hosts; `icons` keeps the legacy domain marks. */
    iconSet?: WebIconSet;
    /** The ids `Tabs` gives a tab and its panel for one `idBase`. */
    tabIds?: {
      tab(idBase: string, id: string): string;
      panel(idBase: string, id: string): string;
    };
    /** The host confirmation alert; resolves true when the person confirms. */
    confirm?(message: string, options?: { title?: string; confirmLabel?: string; destructive?: boolean }): Promise<boolean>;
    syntax: {
      highlight(code: string, language: string): string;
      languageForPath(path: string): string;
    };
    /** React hook for a package window with an inner level (a list and one
     *  item). Pass the step back to the list while the item is shown, else
     *  null. Returns true when the window's own Back (the phone layer) now
     *  performs that step: hide the content's back control then. Returns
     *  false outside a window or on a wide layout. Optional for older hosts. */
    useWindowBack?(handler: (() => void) | null): boolean;
    locale: {
      get(): string;
      translate(key: string, values?: Record<string, string | number>): string;
    };
  };
  errors: {
    friendly(action: string, cause: unknown): string;
    /** Host-owned transient error notice. Optional for compatibility with
     * older package hosts; packages keep contextual form errors in place.
     * `options.kind` (default "error") marks a calm word that is no failure. */
    show?(message: string, action?: WebErrorAction, options?: { kind?: "error" | "warning" | "info" }): void;
  };
  /** The single transient-notification standard (errors, results, updates,
   *  news, hints). Optional for older hosts; feature-detect it. Persistent
   *  records belong to the notification centre, not here. */
  notifications?: {
    show(input: WebNotificationInput): WebNotificationHandle;
    update(id: string, patch: WebNotificationPatch): boolean;
    dismiss(id: string): void;
  };
  handoffTargets: {
    register(registration: HandoffTargetRegistration): Unregister;
    list(): HandoffTargetRegistration[];
  };
  /** Composer contribution seam. Packages add their own items and paste
   *  handlers; the host owns the composer UI and ordering. Optional for older
   *  hosts — packages should feature-detect it. */
  composer?: {
    registerAddMenuItem(item: ComposerAddMenuItem): Unregister;
    registerPasteHandler(handler: ComposerPasteHandler): Unregister;
    /** Register an awaited post-creation step for the composer's new session.
     *  Optional for older hosts; feature-detect it. */
    registerSessionCreatedHook?(hook: ComposerSessionCreatedHook): Unregister;
    listAddMenuItems(): readonly ComposerAddMenuItem[];
    listPasteHandlers(): readonly ComposerPasteHandler[];
    /** All registered session-created hooks in registration order. Optional for
     *  older hosts. */
    listSessionCreatedHooks?(): readonly ComposerSessionCreatedHook[];
    /** Register (or same-id replace) a composer mode. Optional for older
     *  hosts; feature-detect it. */
    registerMode?(mode: ComposerMode): Unregister;
    /** Registered modes, ordered by id. */
    listModes?(): readonly ComposerMode[];
    /** Ask the mounted composer of `sessionId` (any mounted composer when
     *  omitted) to enter `modeId`, or to leave its mode with `null`. True
     *  when a composer took the request. */
    setMode?(modeId: string | null, options?: { sessionId?: string }): boolean;
    /** The mode the mounted composer of `sessionId` is in, if any. Changes
     *  notify `subscribe` listeners. */
    activeMode?(sessionId: string | null): string | null;
    subscribe(listener: () => void): Unregister;
  };
}

export type WebPackageInstaller = () => Unregister;
export type WebPackageEntry = (host: WebPackageHost) => WebPackageInstaller;

export function defineWebPackage(entry: WebPackageEntry): WebPackageEntry {
  return entry;
}

export interface ApiTransportOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  onUnauthorized?: () => void;
  /** Reads that lose their connection are retried; `false` sends each once. */
  readRetry?: ReadRetryOptions | false;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export interface ApiTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  delete<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
}

export function createApiTransport(options: ApiTransportOptions = {}): ApiTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = `${options.baseUrl ?? ""}${path}`;
    const response = options.readRetry === false
      ? await fetchImpl(url, init)
      : await fetchWithReadRetry(fetchImpl, url, init, options.readRetry);
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      const text = await response.text().catch(() => "");
      let code: string | undefined;
      let diagnostics = {};
      const fallback = `HTTP ${response.status} ${response.statusText}`.trim();
      let message = text ? errorBodyText(text) || fallback : fallback;
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        diagnostics = readErrorDiagnostics(parsed);
        if (typeof parsed.error === "string") code = parsed.error;
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        // Preserve a non-JSON response as the diagnostic message.
      }
      throw Object.assign(new ApiError(message, response.status, code), diagnostics);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };
  const withBody = (
    method: string,
    body: unknown,
    init?: RequestInit,
  ): RequestInit => ({
    ...init,
    method,
    headers: body === undefined
      ? init?.headers
      : { ...Object.fromEntries(new Headers(init?.headers)), "content-type": "application/json" },
    body: body === undefined ? init?.body : JSON.stringify(body),
  });
  return {
    request,
    get: (path, init) => request(path, { ...init, method: "GET" }),
    post: (path, body, init) => request(path, withBody("POST", body, init)),
    put: (path, body, init) => request(path, withBody("PUT", body, init)),
    patch: (path, body, init) => request(path, withBody("PATCH", body, init)),
    delete: (path, body, init) => request(path, withBody("DELETE", body, init)),
  };
}

export function friendlyError(action: string, cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  const detail = errorBodyText(raw);
  return detail ? `${action}: ${detail}` : action;
}

/** Stable, scoped identity of a resource — independent of any view or placement. */
/** True while an input method (IME) is composing: Escape then closes the
 *  candidate list and Enter commits a candidate, so neither may close, submit
 *  or cancel anything. Takes a DOM event or a React synthetic event; keyCode
 *  229 covers engines whose events drop `isComposing`. */
export function isImeComposing(event: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
} | null | undefined): boolean {
  if (!event) return false;
  return event.isComposing === true || event.keyCode === 229
    || event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229;
}

export function resourceKey(ref: ResourceRef): string {
  if (ref.repositoryId !== undefined && ref.repositoryId !== "primary") return JSON.stringify([ref.scheme, ref.projectId, ref.sessionId, ref.repositoryId, ref.locator]);
  return `${ref.scheme}:${ref.projectId}:${ref.sessionId ?? "project"}:${ref.locator}`;
}
