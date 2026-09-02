import type { ComponentType, ReactNode } from "react";
import type {
  JsonObject,
  SessionEvent,
  UiSlot,
  WidgetKind,
} from "@polyth/contracts";

export type Unregister = () => void;
export type CapabilityTier = "primary" | "more" | "technical";

export interface SlotRegistration {
  slot: UiSlot;
  id: string;
  render: (props: Record<string, unknown>) => ReactNode;
  order?: number;
  meta?: Record<string, unknown>;
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

export interface WidgetDefinition {
  id: string;
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
  settingsSchema?: Readonly<Record<string, unknown>>;
  render: (context: WidgetRenderContext) => ReactNode;
  settingsRender?: (context: WidgetSettingsContext) => ReactNode;
}

export interface WidgetPlugin {
  id: string;
  name: string;
  widgets?: readonly WidgetDefinition[];
}

export interface SurfaceContext {
  changeCount: number;
  eventCount: number;
  totalTokens: number;
  hasSession: boolean;
}

export interface SurfaceComponentProps {
  active?: boolean;
}

export interface SurfacePresentation {
  kind: "workspace";
  defaultRatio: number;
  minWidth: number;
  minHeight?: number;
  preferredMaxWidth: number;
  keepAlive: boolean;
  escape: "close" | "content";
}

export interface SurfaceDefinition {
  id: string;
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
}

export interface CapabilityDefinition {
  id: string;
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
}

export type SettingsPageGroup = "Workspace" | "Engineering" | "Customize" | "System";

export interface SettingsPageDefinition {
  id: string;
  packageId: string;
  label: string;
  group: SettingsPageGroup;
  icon?: string;
  order?: number;
  component: ComponentType;
  settingsItems?: SettingsSearchItem[];
}

export interface WebStoreSnapshot {
  activeProjectId: string | null;
  activeSessionId: string | null;
  activeView: string;
  overlay: string | null;
  railPlugin: string | null;
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

export interface WebPackageHost {
  slots: {
    register(registration: SlotRegistration): Unregister;
  };
  widgets: {
    register(pluginId: string, definition: WidgetDefinition): Unregister;
    registerPlugin(plugin: WidgetPlugin): Unregister;
  };
  surfaces: {
    register(definition: SurfaceDefinition): Unregister;
  };
  capabilities: {
    register(definition: CapabilityDefinition): Unregister;
  };
  settings: {
    registerPage(definition: SettingsPageDefinition): Unregister;
    registerItems(items: SettingsSearchItem[]): Unregister;
  };
  reducers: {
    register<State = unknown>(eventType: string, reducer: WebEventReducer<State>): Unregister;
  };
  store: {
    getSnapshot(): WebStoreSnapshot;
    subscribe(listener: () => void): Unregister;
    select<T>(selector: (snapshot: WebStoreSnapshot) => T): T;
  };
  navigation: {
    setActiveView(view: string): void;
    openSettingsPage(pageId: string): void;
    openWorkspacePane(surfaceId: string, resource?: string): boolean;
    closeWorkspacePane(): void;
    openRailSurface(surfaceId: string): void;
    setOverlay(overlay: string | null): void;
  };
  ui: {
    icons: Readonly<Record<string, () => ReactNode>>;
    Dialog: ComponentType<WebDialogProps>;
  };
  errors: {
    friendly(action: string, cause: unknown): string;
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
