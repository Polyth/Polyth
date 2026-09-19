import type { ButtonHTMLAttributes, ChangeEvent, ComponentType, FocusEvent, InputHTMLAttributes, KeyboardEvent, ReactNode } from "react";
import type {
  DraftExecutionConfig,
  JsonObject,
  SessionEvent,
  SessionProjection,
  UiSlot,
  WidgetKind,
  PanelItemSize,
} from "@polyth/contracts";

export type Unregister = () => void;
export type CapabilityTier = "primary" | "more" | "technical";

export interface SlotRegistration {
  slot: UiSlot;
  id: string;
  render: (props: Record<string, unknown>) => ReactNode;
  order?: number;
  meta?: Record<string, unknown>;
  /** Host-bound owner package id. Package callers should omit this. */
  ownerPackageId?: string;
}

export interface WidgetRenderContext extends Record<string, unknown> {
  projectId: string | null;
  sessionId: string | null;
  editing: boolean;
  instanceId: string;
  config: Readonly<JsonObject>;
  updateConfig: (config: JsonObject) => void;
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
  render: (context: WidgetRenderContext) => ReactNode;
  settingsRender?: (context: WidgetSettingsContext) => ReactNode;
}

export interface AddWidgetToCanvasOptions {
  /** Per-instance config applied only to the newly revealed/created instance. */
  config?: JsonObject;
  /** Duplicate an already-visible duplicatable widget. Defaults to true. */
  duplicate?: boolean;
}

export interface AddWidgetToCanvasResult {
  instanceId: string;
  duplicated: boolean;
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

export interface WorkbenchProfileDefinition {
  id: string;
  label: string;
  description: string;
  order: number;
  available?: () => boolean;
  defaultLayout: WorkbenchLayoutTemplate;
  /** Presentation hints (e.g. `{ text: "prose" }`). Never geometry. */
  presentation?: Readonly<Record<string, unknown>>;
}

export interface WorkbenchProfileSummary {
  id: string;
  label: string;
  description: string;
  order: number;
  available: boolean;
  presentation: Readonly<Record<string, unknown>>;
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
  component: (props?: SurfaceComponentProps) => ReactNode;
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
}

export interface ResourceSelection {
  startLine: number;
  endLine?: number;
  column?: number;
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

export interface OpenResourceOptions {
  selection?: ResourceSelection;
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
  standardRank: number;
  open: () => void;
  available: () => boolean;
  unavailableReason?: () => string | null;
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

export interface HandoffTargetInput {
  projectId: string;
  sessionId?: string | null;
  text: string;
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
export interface WebButtonProps extends Pick<ButtonHTMLAttributes<HTMLButtonElement>, "type"> { children?: ReactNode; className?: string; size?: "sm" | "md" | "lg"; variant?: "primary" | "ghost" | "quiet" | "danger"; busy?: boolean; disabled?: boolean; title?: string; "aria-label"?: string; iconStart?: () => ReactNode; onClick?: () => void; "aria-pressed"?: boolean; }
export interface WebInputProps extends Pick<InputHTMLAttributes<HTMLInputElement>, "autoComplete" | "required" | "type"> { value?: string; placeholder?: string; className?: string; disabled?: boolean; "aria-label"?: string; onChange?: (event: ChangeEvent<HTMLInputElement>) => void; onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void; onBlur?: (event: FocusEvent<HTMLInputElement>) => void; }
export interface WebEmptyStateProps { title: string; description?: string; actionLabel?: string; onAction?: () => void; }

export interface ConversationSeed {
  title?: string;
  draft?: string;
}

export interface WebErrorAction {
  label: string;
  run(): void | Promise<void>;
}

export interface WebPackageHost {
  slots: {
    register(registration: SlotRegistration): Unregister;
    list(slot: UiSlot): Array<{ id: string; order: number; meta?: Readonly<Record<string, unknown>> }>;
  };
  widgets: {
    register(pluginId: string, definition: WidgetDefinition): Unregister;
    registerPlugin(plugin: WidgetPlugin): Unregister;
    /**
     * Package-safe bridge from a feature surface into the host-owned Canvas
     * layout. Hosts without Canvas may omit it; packages must degrade cleanly.
     */
    addToCanvas?(
      definitionId: string,
      options?: AddWidgetToCanvasOptions,
    ): AddWidgetToCanvasResult | null;
  };
  surfaces: {
    register(definition: SurfaceDefinition): Unregister;
  };
  capabilities: {
    register(definition: CapabilityDefinition): Unregister;
    /** Re-render consumers when a registered capability's `available()`
     *  result changes without replacing the descriptor. */
    notify(): void;
  };
  settings: {
    registerPage(definition: SettingsPageDefinition): Unregister;
    registerItems(items: SettingsSearchItem[]): Unregister;
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
  };
  /** Canonical composer/session handoff. Package UI never reaches into the
   * shell store or composer event bus directly. */
  conversation: {
    insert(text: string): void;
    startNewSession(projectId: string, seed?: ConversationSeed): void;
    openSession(sessionId: string): Promise<void>;
  };
  navigation: {
    setActiveView(view: string): void;
    openSettingsPage(pageId: string, target?: SettingsNavigationTarget): void;
    openWorkspacePane(surfaceId: string, resource?: string): boolean;
    closeWorkspacePane(): void;
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
    icons: Readonly<Record<string, () => ReactNode>>;
    Dialog: ComponentType<WebDialogProps>;
    Slot: ComponentType<{ slot: UiSlot; context?: Record<string, unknown>; customizable?: boolean }>;
    components: Readonly<{
      Button: WebUiComponent<WebButtonProps>;
      IconButton: WebUiComponent<Record<string, unknown>>;
      Menu: WebUiComponent<Record<string, unknown>>;
      Tabs: WebUiComponent<Record<string, unknown>>;
      TextInput: WebUiComponent<WebInputProps>;
      Textarea: WebUiComponent<Record<string, unknown>>;
      Checkbox: WebUiComponent<Record<string, unknown>>;
      Select: WebUiComponent<Record<string, unknown>>;
      EmptyState: WebUiComponent<WebEmptyStateProps>;
      MarkdownDoc: WebUiComponent<Record<string, unknown>>;
    }>;
    syntax: {
      highlight(code: string, language: string): string;
      languageForPath(path: string): string;
    };
    locale: {
      get(): string;
      translate(key: string, values?: Record<string, string | number>): string;
    };
  };
  errors: {
    friendly(action: string, cause: unknown): string;
    /** Host-owned transient error notice. Optional for compatibility with
     * older package hosts; packages keep contextual form errors in place. */
    show?(message: string, action?: WebErrorAction): void;
  };
  handoffTargets: {
    register(registration: HandoffTargetRegistration): Unregister;
    list(): HandoffTargetRegistration[];
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
    const response = await fetchImpl(`${options.baseUrl ?? ""}${path}`, init);
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      const text = await response.text().catch(() => "");
      let code: string | undefined;
      let message = text || `HTTP ${response.status} ${response.statusText}`.trim();
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        if (typeof parsed.error === "string") code = parsed.error;
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        // Preserve a non-JSON response as the diagnostic message.
      }
      throw new ApiError(message, response.status, code);
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
  const detail = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return detail ? `${action}: ${detail}` : action;
}

/** Stable, scoped identity of a resource — independent of any view or placement. */
export function resourceKey(ref: ResourceRef): string {
  return `${ref.scheme}:${ref.projectId}:${ref.sessionId ?? "project"}:${ref.locator}`;
}
