import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, httpStatusOf } from "@polyth/session/web-api";
import type { SurfaceComponentProps, WebPackageHost } from "@polyth/web-sdk";
import {
  PLAYGROUND_ARTIFACT_PATH,
  PLAYGROUND_CHANNEL,
  newPlaygroundOperationId,
  playgroundBootstrapPrompt,
  playgroundSelectionPrompt,
  sandboxPreviewDocument,
  type PlaygroundSelection,
  type PlaygroundViewport,
} from "../src/index.ts";

interface PlaygroundViewProps extends SurfaceComponentProps {
  host: WebPackageHost;
}

const VIEWPORTS: ReadonlyArray<{ id: PlaygroundViewport; label: string }> = [
  { id: "responsive", label: "Responsive" },
  { id: "desktop", label: "Desktop" },
  { id: "tablet", label: "Tablet" },
  { id: "mobile", label: "Mobile" },
];

function armedKey(sessionId: string): string {
  return "polyth.playground.armed.v1." + sessionId;
}

function isArmed(sessionId: string | null): boolean {
  if (!sessionId || typeof localStorage === "undefined") return false;
  try { return localStorage.getItem(armedKey(sessionId)) === "1"; } catch { return false; }
}

function rememberArmed(sessionId: string): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(armedKey(sessionId), "1"); } catch { /* private browsing / quota */ }
}

export default function PlaygroundView({ host, projectId: scopedProjectId, sessionId: scopedSessionId, active }: PlaygroundViewProps) {
  const snapshot = useSyncExternalStore(host.store.subscribe, host.store.getSnapshot, host.store.getSnapshot);
  const projectId = scopedProjectId === undefined ? snapshot.activeProjectId : scopedProjectId;
  const sessionId = scopedSessionId === undefined ? snapshot.activeSessionId : scopedSessionId;
  const session = sessionId ? host.sessions.get(sessionId) : undefined;
  const working = session?.status === "working" || session?.status === "waiting";
  const { Button, EmptyState } = host.ui.components;

  const [artifactHtml, setArtifactHtml] = useState("");
  const [artifactExists, setArtifactExists] = useState(false);
  const [artifactRevision, setArtifactRevision] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [viewport, setViewport] = useState<PlaygroundViewport>("responsive");
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [inspectMode, setInspectMode] = useState(false);
  const [selection, setSelection] = useState<PlaygroundSelection | null>(null);
  const [arming, setArming] = useState(false);
  const [armed, setArmed] = useState(() => isArmed(sessionId ?? null));
  const [previewEpoch, setPreviewEpoch] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const revisionRef = useRef("");
  const scopeKey = (projectId ?? "none") + ":" + (sessionId ?? "project");
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  useEffect(() => {
    setArmed(isArmed(sessionId ?? null));
  }, [sessionId]);

  useEffect(() => {
    revisionRef.current = "";
    setArtifactRevision("");
    setArtifactHtml("");
    setArtifactExists(false);
    setError("");
    setSelection(null);
    setInspectMode(false);
    setLoading(Boolean(projectId));
  }, [scopeKey, projectId]);

  const refreshArtifact = useCallback(async (force = false) => {
    if (!projectId) {
      setLoading(false);
      setArtifactExists(false);
      return;
    }
    const requestScope = (projectId ?? "none") + ":" + (sessionId ?? "project");
    try {
      const stat = await api.filesStat(projectId, PLAYGROUND_ARTIFACT_PATH, sessionId ?? undefined);
      if (scopeRef.current !== requestScope) return;
      setArtifactExists(true);
      if (!force && revisionRef.current === stat.revision) {
        setLoading(false);
        setError("");
        return;
      }
      const response = await fetch(api.filesRawUrl(projectId, PLAYGROUND_ARTIFACT_PATH, sessionId ?? undefined), {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw Object.assign(new Error("Preview file returned HTTP " + response.status), { status: response.status });
      const html = await response.text();
      if (scopeRef.current !== requestScope) return;
      revisionRef.current = stat.revision;
      setArtifactRevision(stat.revision);
      setArtifactHtml(html);
      setArtifactExists(true);
      setLoading(false);
      setError("");
    } catch (cause) {
      if (scopeRef.current !== requestScope) return;
      if (httpStatusOf(cause) === 404 || (cause && typeof cause === "object" && "status" in cause && cause.status === 404)) {
        revisionRef.current = "";
        setArtifactRevision("");
        setArtifactHtml("");
        setArtifactExists(false);
        setLoading(false);
        setError("");
        return;
      }
      setLoading(false);
      setError(host.errors.friendly("Could not refresh Playground", cause));
    }
  }, [host.errors, projectId, sessionId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refreshArtifact();
      if (cancelled) return;
      const delay = active === false ? 2500 : working ? 350 : 900;
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, projectId, refreshArtifact, working]);

  const previewDocument = useMemo(
    () => sandboxPreviewDocument(artifactHtml, networkEnabled),
    [artifactHtml, networkEnabled],
  );

  const sendInspectState = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({
      channel: PLAYGROUND_CHANNEL,
      kind: "inspect",
      enabled: inspectMode,
    }, "*");
  }, [inspectMode]);

  useEffect(() => {
    sendInspectState();
  }, [previewDocument, sendInspectState]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { channel?: string; kind?: string; selector?: string; tag?: string; text?: string } | null;
      if (!data || data.channel !== PLAYGROUND_CHANNEL) return;
      if (data.kind === "ready") {
        sendInspectState();
        return;
      }
      if (data.kind !== "selected" || !data.selector || !data.tag) return;
      setSelection({ selector: data.selector, tag: data.tag, text: data.text ?? "" });
      setInspectMode(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendInspectState]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const armPlayground = useCallback(async () => {
    if (!projectId || arming) return;
    setArming(true);
    setError("");
    try {
      let targetSessionId = sessionId ?? null;
      if (!targetSessionId) {
        const created = await api.createSession({ projectId, title: "Playground" });
        targetSessionId = created.id;
        await host.conversation.openSession(targetSessionId);
      }
      const target = host.sessions.get(targetSessionId);
      const busy = target?.status === "working" || target?.status === "waiting";
      await api.sendMessage(targetSessionId, {
        text: playgroundBootstrapPrompt(artifactExists),
        hiddenUserMessage: true,
        clientOperationId: newPlaygroundOperationId(),
        ...(busy ? { delivery: "queue" } : {}),
      });
      rememberArmed(targetSessionId);
      setArmed(true);
      setNotice(busy ? "Playground will activate after the current turn." : "Playground is active for this chat.");
    } catch (cause) {
      setError(host.errors.friendly("Could not activate Playground", cause));
    } finally {
      setArming(false);
    }
  }, [arming, artifactExists, host, projectId, sessionId]);

  const addSelectionToChat = useCallback(() => {
    if (!selection) return;
    host.conversation.insert(playgroundSelectionPrompt(selection));
    setSelection(null);
    host.workbench.openSurface("session");
  }, [host, selection]);

  const openSource = useCallback(() => {
    if (!projectId) return;
    host.navigation.openResource({
      scheme: "file",
      locator: PLAYGROUND_ARTIFACT_PATH,
      projectId,
      sessionId: sessionId ?? null,
    });
  }, [host.navigation, projectId, sessionId]);

  if (!projectId) {
    return (
      <div className="playground-view">
        <EmptyState title="Open a project" description="Playground keeps its live artifact inside the current project." />
      </div>
    );
  }

  const sourceLabel = artifactRevision ? "Live" : "Waiting";

  return (
    <div className="playground-view" data-viewport={viewport}>
      <div className="playground-toolbar">
        <div className="playground-status" title={working ? "Agent is editing" : "Live artifact status"}>
          <span className={"playground-status-dot" + (working ? " is-working" : artifactExists ? " is-live" : "")} />
          <span>{working ? "Updating" : sourceLabel}</span>
        </div>

        <div className="playground-viewport-group" role="group" aria-label="Preview viewport">
          {VIEWPORTS.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={viewport === item.id ? "primary" : "quiet"}
              aria-pressed={viewport === item.id}
              onClick={() => setViewport(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        <span className="playground-toolbar-spacer" />

        <Button
          size="sm"
          variant={inspectMode ? "primary" : "quiet"}
          disabled={!artifactExists}
          aria-pressed={inspectMode}
          title="Pick an element in the preview and add it to chat as context."
          onClick={() => setInspectMode((value) => !value)}
        >
          Select
        </Button>
        <Button
          size="sm"
          variant={networkEnabled ? "primary" : "quiet"}
          aria-pressed={networkEnabled}
          title="Allow the prototype to make HTTPS fetch/WebSocket requests. Off is the safer default."
          onClick={() => setNetworkEnabled((value) => !value)}
        >
          Network {networkEnabled ? "on" : "off"}
        </Button>
        <Button size="sm" variant="quiet" disabled={!artifactExists} onClick={openSource}>Source</Button>
        <Button
          size="sm"
          variant="quiet"
          disabled={!artifactExists}
          onClick={() => { setPreviewEpoch((value) => value + 1); void refreshArtifact(true); }}
        >
          Reload
        </Button>
        <Button size="sm" variant={armed ? "quiet" : "primary"} busy={arming} onClick={() => void armPlayground()}>
          {armed ? "Resync agent" : "Enable agent"}
        </Button>
      </div>

      {error && <div className="playground-notice is-error" role="alert">{error}</div>}
      {notice && <div className="playground-notice" role="status">{notice}</div>}

      <div className="playground-stage">
        {loading && !artifactExists ? (
          <div className="playground-empty">
            <EmptyState title="Loading Playground" description="Checking for a live artifact…" />
          </div>
        ) : !artifactExists ? (
          <div className="playground-empty">
            <EmptyState
              title={armed ? "Tell the chat what to build" : "Enable Playground for this chat"}
              description={armed
                ? "The first relevant design request will create the live artifact here. Every saved change then appears automatically."
                : "Playground gives the agent a session-scoped live-design instruction, while the normal Polyth chat remains the conversation surface."}
              actionLabel={armed ? "Open chat" : "Enable Playground"}
              onAction={armed ? () => { host.workbench.openSurface("session"); } : () => { void armPlayground(); }}
            />
          </div>
        ) : (
          <div className="playground-device-shell">
            <iframe
              key={artifactRevision + ":" + previewEpoch + ":" + String(networkEnabled)}
              ref={iframeRef}
              className="playground-frame"
              title="Playground live preview"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={previewDocument}
              onLoad={sendInspectState}
            />
          </div>
        )}
      </div>

      {selection && (
        <div className="playground-selection" role="status">
          <div className="playground-selection-copy">
            <strong>{selection.selector}</strong>
            {selection.text && <span>{selection.text}</span>}
          </div>
          <Button size="sm" variant="primary" onClick={addSelectionToChat}>Add to chat</Button>
          <Button size="sm" variant="quiet" onClick={() => setSelection(null)}>Clear</Button>
        </div>
      )}
    </div>
  );
}
