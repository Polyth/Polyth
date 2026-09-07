import type { InstalledPluginDto } from "@polyth/contracts";
import type { RemoteUiAction, RemoteUiNode } from "@polyth/package-sdk";
import {
  MAX_IN_FLIGHT,
  PROTOCOL_CHANNEL,
  PROTOCOL_VERSION,
  createMethodRegistry,
  REMOTE_UI_MAX_UPDATES_PER_SEC,
  createRateLimiter,
  eventEnvelope,
  parseEnvelope,
  responseError,
  responseOk,
  resolvePackageErrorCode,
  sandboxHandshakeReady,
  verifySandboxHello,
  parseRemoteUiTree,
  type HandshakeReady,
  type HostMethodContext,
} from "@polyth/package-sdk/host";
import { api } from "@polyth/session/web-api";
import { announce } from "../../components/a11y/announce.ts";
import { promptAlert } from "../../alerts.ts";
import { tr } from "../../i18n/index.ts";
import { requestComposerInsert, requestComposerReplace } from "../../composerInsert.ts";
import { saveDraft } from "../../utils.ts";
import { getState, openWorkspacePane, setRailPlugin } from "../../store.ts";
import { loadSettings } from "../../settings.ts";
import { registerComposerActionDeliverer, takePendingComposerAction, clearPackageComposerActions } from "./composerAction.ts";

export interface SandboxRuntime {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly surfaceId: string;
  subscribe(listener: (tree: RemoteUiNode | null) => void): () => void;
  sendAction(action: RemoteUiAction): void;
  dispose(): void;
}

interface LiveRuntime extends SandboxRuntime {
  refs: number;
  iframe: HTMLIFrameElement;
  port: MessagePort | null;
  tree: RemoteUiNode | null;
  listeners: Set<(tree: RemoteUiNode | null) => void>;
  disposed: boolean;
  inFlight: number;
  limiter: ReturnType<typeof createRateLimiter>;
  renderLimiter: ReturnType<typeof createRateLimiter>;
  onWindowMessage: (event: MessageEvent) => void;
  unregisterDeliverer?: () => void;
}

const live = new Map<string, LiveRuntime>();

export function runtimeKey(pluginId: string, surfaceId: string): string {
  return `${pluginId}:${surfaceId}`;
}

export function disposePackageRuntimes(pluginId: string): void {
  for (const runtime of [...live.values()]) {
    if (runtime.pluginId === pluginId) tearDown(runtime);
  }
  clearPackageComposerActions(pluginId);
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function capabilitySet(plugin: InstalledPluginDto): Set<string> {
  return new Set(plugin.permissions.effective);
}

function declaredCapabilitySet(plugin: InstalledPluginDto): Set<string> {
  return new Set(plugin.permissions.requested.map((item) => item.name));
}

function sandboxSurfaceIds(plugin: InstalledPluginDto): string[] {
  const ids: string[] = [];
  for (const item of plugin.contributions) {
    if (item.module.startsWith("sandbox-surface:")) {
      ids.push(item.module.slice("sandbox-surface:".length));
    }
  }
  return ids;
}

async function loadBundle(plugin: InstalledPluginDto): Promise<string> {
  if (!plugin.sandbox) throw new Error("package has no sandbox bundle");
  const response = await fetch(plugin.sandbox.url);
  if (!response.ok) throw new Error("sandbox bundle is unavailable");
  const source = await response.text();
  return source;
}

function handshake(plugin: InstalledPluginDto, surfaceId: string, instanceId: string): HandshakeReady {
  const theme = loadSettings().appearanceMode;
  const dark = theme === "dark"
    || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return sandboxHandshakeReady({
    packageId: plugin.id,
    packageVersion: plugin.version,
    runtimeInstanceId: instanceId,
    surfaceId,
    capabilities: sandboxHandshakeCapabilityList(plugin),
    theme: { mode: dark ? "dark" : "light" },
    locale: document.documentElement.lang || "en",
  });
}

/** Effective capabilities sent on the sandbox handshake. Never candidate review. */
export function sandboxHandshakeCapabilityList(plugin: InstalledPluginDto): string[] {
  return [...capabilitySet(plugin)];
}

export async function acquireSandboxRuntime(
  plugin: InstalledPluginDto,
  surfaceId: string,
): Promise<SandboxRuntime> {
  const key = runtimeKey(plugin.id, surfaceId);
  const existing = live.get(key);
  if (existing && !existing.disposed) {
    existing.refs += 1;
    return existing;
  }
  const instanceId = `rt-${nonce()}`;
  const mountNonce = nonce();
  const source = await loadBundle(plugin);
  const scriptNonce = nonce();
  const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'none'; style-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
</head><body>
<script type="module" nonce="${scriptNonce}">
window.__POLYTH_MOUNT__=${JSON.stringify(mountNonce)};
${source}
</script>
</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.title = `${plugin.name} sandbox`;
  iframe.className = "polyth-sandbox-frame";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none";
  iframe.srcdoc = html;

  const runtime: LiveRuntime = {
    instanceId,
    pluginId: plugin.id,
    surfaceId,
    refs: 1,
    iframe,
    port: null,
    tree: null,
    listeners: new Set(),
    disposed: false,
    inFlight: 0,
    limiter: createRateLimiter(),
    renderLimiter: createRateLimiter(REMOTE_UI_MAX_UPDATES_PER_SEC, 1000),
    onWindowMessage: () => undefined,
    subscribe(listener) {
      runtime.listeners.add(listener);
      listener(runtime.tree);
      return () => runtime.listeners.delete(listener);
    },
    sendAction(action) {
      runtime.port?.postMessage(eventEnvelope("ui.action", action));
    },
    dispose() {
      if (runtime.disposed) return;
      runtime.refs -= 1;
      if (runtime.refs > 0) return;
      tearDown(runtime);
    },
  };

  const methods = createMethodRegistry([
    {
      method: "runtime.hello",
      invoke: () => handshake(plugin, surfaceId, instanceId),
    },
    {
      method: "ui.render",
      capability: "ui.render",
      invoke: (_ctx, payload) => {
        runtime.tree = parseRemoteUiTree(payload);
        for (const listener of runtime.listeners) listener(runtime.tree);
        return { ok: true };
      },
    },
    {
      method: "ui.toast",
      capability: "ui.toast",
      invoke: (_ctx, payload) => {
        const message = payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message
          : "";
        if (message) announce(message);
        return { ok: true };
      },
    },
    {
      method: "ui.openSurface",
      capability: "ui.openSurface",
      invoke: (_ctx, payload) => {
        const surface = payload && typeof payload === "object" ? String((payload as { surfaceId?: unknown }).surfaceId ?? "") : "";
        const declared = sandboxSurfaceIds(plugin).includes(surface);
        if (!declared || surface.includes(".") || surface.includes("/") || surface.includes(":")) {
          throw Object.assign(new Error("surface is not declared"), { code: "INVALID_REQUEST" });
        }
        const id = `slot:${plugin.id}.surface.${surface}`;
        if (!openWorkspacePane(id)) setRailPlugin(id);
        return { ok: true };
      },
    },
    {
      method: "ui.openExternalUrl",
      capability: "ui.openExternalUrl",
      invoke: (_ctx, payload) => {
        const url = payload && typeof payload === "object" ? String((payload as { url?: unknown }).url ?? "") : "";
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") throw Object.assign(new Error("only https URLs can be opened"), { code: "INVALID_REQUEST" });
        window.open(parsed.toString(), "_blank", "noopener,noreferrer");
        return { ok: true };
      },
    },
    {
      method: "clipboard.write",
      capability: "clipboard.write",
      invoke: async (_ctx, payload) => {
        const text = payload && typeof payload === "object" ? String((payload as { text?: unknown }).text ?? "") : "";
        await navigator.clipboard.writeText(text);
        return { ok: true };
      },
    },
    {
      method: "composer.write",
      capability: "composer.write",
      invoke: (_ctx, payload) => {
        const body = payload && typeof payload === "object" ? payload as { text?: unknown; mode?: unknown } : {};
        const text = typeof body.text === "string" ? body.text : "";
        const sessionId = getState().activeSessionId;
        if (body.mode === "append") requestComposerInsert(text);
        else {
          requestComposerReplace(text);
          if (sessionId) saveDraft(sessionId, text);
        }
        return { ok: true };
      },
    },
    {
      method: "composer.send",
      capability: "composer.send",
      invoke: async (_ctx, payload) => {
        const sessionId = getState().activeSessionId;
        if (!sessionId) throw Object.assign(new Error("no active session"), { code: "INVALID_REQUEST" });
        const text = payload && typeof payload === "object"
          ? String((payload as { text?: unknown }).text ?? "")
          : "";
        if (!text.trim()) throw Object.assign(new Error("text is required"), { code: "INVALID_REQUEST" });
        await api.sendMessage(sessionId, { text });
        return { ok: true };
      },
    },
    {
      method: "auth.connect",
      capability: "auth.connection",
      invoke: async (_ctx, payload) => {
        const id = payload && typeof payload === "object" ? String((payload as { id?: unknown }).id ?? "") : "";
        const spec = (plugin.connections ?? []).find((item) => item.id === id);
        if (!spec) throw Object.assign(new Error("connection is not declared"), { code: "RESOURCE_NOT_FOUND" });
        if (spec.kind === "oauth") {
          const started = await api.pluginsStartOauth(plugin.id, spec.id);
          if (typeof started.url === "string" && started.url.startsWith("https:")) {
            window.open(started.url, "_blank", "noopener,noreferrer");
          }
          return started;
        }
        const token = await promptAlert(tr("packages.plugins.enterTokenFor", { label: spec.label }), {
          title: tr("packages.plugins.connectionToken"),
          secret: true,
        });
        if (!token) throw Object.assign(new Error("connection cancelled"), { code: "HOST_REJECTED" });
        return api.pluginsSetConnectionToken(plugin.id, spec.id, token);
      },
    },
  ]);

  const onWindowMessage = (event: MessageEvent) => {
    if (runtime.disposed || runtime.port) return;
    if (!verifySandboxHello({
      eventSource: event.source,
      expectedSource: iframe.contentWindow,
      data: event.data,
      mountNonce,
    })) return;
    const channel = new MessageChannel();
    runtime.port = channel.port1;
    channel.port1.start();
    const pendingAction = takePendingComposerAction(plugin.id, surfaceId);
    if (pendingAction) {
      channel.port1.postMessage(eventEnvelope("composer.action", { actionId: pendingAction }));
    }
    channel.port1.onmessage = (portEvent) => {
      void handlePort(runtime, plugin, methods, portEvent.data);
    };
    iframe.contentWindow?.postMessage(
      { channel: PROTOCOL_CHANNEL, v: PROTOCOL_VERSION, kind: "port" },
      "*",
      [channel.port2],
    );
  };
  runtime.onWindowMessage = onWindowMessage;
  window.addEventListener("message", onWindowMessage);
  runtime.unregisterDeliverer = registerComposerActionDeliverer(plugin.id, surfaceId, (actionId) => {
    if (!runtime.port || runtime.disposed) return false;
    runtime.port.postMessage(eventEnvelope("composer.action", { actionId }));
    return true;
  });
  document.body.appendChild(iframe);
  live.set(key, runtime);
  return runtime;
}

async function handlePort(
  runtime: LiveRuntime,
  plugin: InstalledPluginDto,
  methods: ReturnType<typeof createMethodRegistry>,
  data: unknown,
): Promise<void> {
  if (runtime.disposed || !runtime.port) return;
  const envelope = parseEnvelope(data);
  if (!envelope) return;
  if (envelope.kind !== "request" || !envelope.id || !envelope.method) return;
  const isRender = envelope.method === "ui.render" || envelope.method === "ui.toast";
  if (isRender) {
    if (!runtime.renderLimiter.take()) {
      runtime.port.postMessage(responseError(envelope.id, "HOST_REJECTED", "render rate limit exceeded"));
      return;
    }
  } else if (!runtime.limiter.take()) {
    runtime.port.postMessage(responseError(envelope.id, "HOST_REJECTED", "rate limit exceeded"));
    return;
  }
  if (runtime.inFlight >= MAX_IN_FLIGHT) {
    runtime.port.postMessage(responseError(envelope.id, "HOST_REJECTED", "too many in-flight requests"));
    return;
  }
  runtime.inFlight += 1;
  const ctx: HostMethodContext = {
    packageId: plugin.id,
    runtimeInstanceId: runtime.instanceId,
    surfaceId: runtime.surfaceId,
    capabilities: capabilitySet(plugin),
    declared: declaredCapabilitySet(plugin),
  };
  try {
    let result: unknown;
    const payload = envelope.payload;
    if (methods.get(envelope.method)) {
      result = await methods.invoke(envelope.method, ctx, payload);
    } else {
      const state = getState();
      const response = await api.pluginsRpc(plugin.id, envelope.method, payload, {
        sessionId: state.activeSessionId ?? undefined,
        projectId: state.activeProjectId ?? undefined,
      });
      if (!response.ok) {
        throw Object.assign(new Error(response.error?.message ?? "request failed"), {
          code: response.error?.code ?? "HOST_REJECTED",
        });
      }
      result = response.payload;
    }
    if (runtime.disposed || !runtime.port) return;
    runtime.port.postMessage(responseOk(envelope.id, result));
  } catch (cause) {
    const error = cause as Error & { code?: string };
    const code = resolvePackageErrorCode(error.code);
    if (runtime.disposed || !runtime.port) return;
    runtime.port.postMessage(responseError(envelope.id, code, error.message));
  } finally {
    runtime.inFlight -= 1;
  }
}

function tearDown(runtime: LiveRuntime): void {
  if (runtime.disposed) return;
  runtime.disposed = true;
  runtime.refs = 0;
  runtime.unregisterDeliverer?.();
  runtime.unregisterDeliverer = undefined;
  window.removeEventListener("message", runtime.onWindowMessage);
  runtime.port?.close();
  runtime.port = null;
  runtime.iframe.remove();
  runtime.listeners.clear();
  live.delete(runtimeKey(runtime.pluginId, runtime.surfaceId));
}

