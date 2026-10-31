import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, httpStatusOf } from "@polyth/session/web-api";
import type { SurfaceComponentProps, WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  PLAYGROUND_CHANNEL,
  playgroundArtifactPath,
  playgroundImplementationPrompt,
  playgroundScopeKey,
  playgroundSelectionPrompt,
  sandboxPreviewDocument,
  type PlaygroundSelection,
  type PlaygroundViewport,
} from "../src/index.ts";

interface PlaygroundViewProps extends SurfaceComponentProps {
  host: WebPackageHost;
}

const VIEWPORTS = [
  { id: "responsive", label: "playground.view.responsive" },
  { id: "desktop", label: "playground.view.desktop" },
  { id: "tablet", label: "playground.view.tablet" },
  { id: "mobile", label: "playground.view.mobile" },
] as const satisfies ReadonlyArray<{ id: PlaygroundViewport; label: string }>;

export default function PlaygroundView({ host, projectId: scopedProjectId, sessionId: scopedSessionId, active }: PlaygroundViewProps) {
  const snapshot = useSyncExternalStore(host.store.subscribe, host.store.getSnapshot, host.store.getSnapshot);
  const projectId = scopedProjectId === undefined ? snapshot.activeProjectId : scopedProjectId;
  const sessionId = scopedSessionId === undefined ? snapshot.activeSessionId : scopedSessionId;
  const session = sessionId ? host.sessions.get(sessionId) : undefined;
  const working = session?.status === "working" || session?.status === "waiting";
  const isPlaygroundMode = host.workbench.getSnapshot().activeProfile === "playground";
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
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [previewEpoch, setPreviewEpoch] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const revisionRef = useRef("");
  const scopeKey = playgroundScopeKey(projectId, sessionId);
  const scopeRef = useRef(scopeKey);
  const requestGeneration = useRef(0);
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    requestGeneration.current += 1;
  }

  useEffect(() => {
    revisionRef.current = "";
    setArtifactRevision("");
    setArtifactHtml("");
    setArtifactExists(false);
    setError("");
    setSelection(null);
    setInspectMode(false);
    setNetworkEnabled(false);
    setNotice("");
    setLoading(Boolean(projectId && sessionId));
    return () => { requestGeneration.current += 1; };
  }, [scopeKey, projectId, sessionId]);

  const refreshArtifact = useCallback(async (force = false) => {
    const requestScope = playgroundScopeKey(projectId, sessionId);
    const generation = ++requestGeneration.current;
    const stillOwned = () => scopeRef.current === requestScope && requestGeneration.current === generation;
    if (!projectId || !sessionId) {
      if (!stillOwned()) return;
      revisionRef.current = "";
      setArtifactRevision("");
      setArtifactHtml("");
      setArtifactExists(false);
      setLoading(false);
      return;
    }
    let artifactPath: string;
    try {
      artifactPath = playgroundArtifactPath(sessionId);
    } catch (cause) {
      if (!stillOwned()) return;
      setLoading(false);
      setArtifactExists(false);
      setError(host.errors.friendly(tr("playground.error.resolveArtifact"), cause));
      return { ok: false, notFound: false };
    }
    try {
      const stat = await api.filesStatOptional(projectId, artifactPath, sessionId);
      if (!stillOwned()) return;
      if (!stat) {
        revisionRef.current = "";
        setArtifactRevision("");
        setArtifactHtml("");
        setArtifactExists(false);
        setLoading(false);
        setError("");
        return { ok: true, notFound: true };
      }
      setArtifactExists(true);
      if (!force && stat.revision && revisionRef.current === stat.revision) {
        setLoading(false);
        setError("");
        return;
      }
      const response = await fetch(api.filesRawUrl(projectId, artifactPath, sessionId), {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw Object.assign(new Error(tr("playground.error.previewHttp", { status: response.status })), { status: response.status });
      const html = await response.text();
      if (!stillOwned()) return;
      revisionRef.current = stat.revision ?? "";
      setArtifactRevision(stat.revision ?? "");
      setArtifactHtml(html);
      setArtifactExists(true);
      setLoading(false);
      setError("");
      return { ok: true, notFound: false };
    } catch (cause) {
      if (!stillOwned()) return;
      if (httpStatusOf(cause) === 404 || (cause && typeof cause === "object" && "status" in cause && cause.status === 404)) {
        revisionRef.current = "";
        setArtifactRevision("");
        setArtifactHtml("");
        setArtifactExists(false);
        setLoading(false);
        setError("");
        return { ok: true, notFound: true };
      }
      setLoading(false);
      setError(host.errors.friendly(tr("playground.error.refresh"), cause));
      return { ok: false, notFound: false };
    }
  }, [host.errors, projectId, sessionId]);

  useEffect(() => {
    if (!projectId || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const res = await refreshArtifact();
      if (cancelled) return;
      const delay = active === false
        ? 2500
        : res && !res.ok
          ? 5000
          : res?.notFound
            ? working ? 1500 : 5000
            : working ? 350 : 900;
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, projectId, refreshArtifact, sessionId, working]);

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

  const swapPanes = useCallback(() => {
    host.workbench.swapSurfaces("session", "playground");
  }, [host]);

  const addSelectionToChat = useCallback(() => {
    if (!selection || !sessionId) return;
    host.conversation.insert(playgroundSelectionPrompt(selection, sessionId));
    setSelection(null);
    host.workbench.openSurface("session");
  }, [host, selection, sessionId]);

  const sendToWorkChat = useCallback(async () => {
    if (!projectId || !sessionId || !artifactExists || handoffBusy) return;
    const brief = playgroundImplementationPrompt({
      sourceSessionId: sessionId,
      artifactHtml,
      selectedElement: selection,
      worktreePath: session?.worktreePath,
    });
    setHandoffBusy(true);
    setError("");
    setNotice("");
    try {
      const workSessionId = host.workbench.getProfileSession("conversation");
      if (workSessionId) {
        const target = host.sessions.get(workSessionId);
        const busy = target?.status === "working" || target?.status === "waiting";
        const delivery = busy ? "queue" : "normal";
        const sent = await host.conversation.send(workSessionId, brief, { delivery });
        if (!sent) throw new Error(tr("playground.error.handoffRejected"));
        setNotice(busy ? tr("playground.notice.queued") : tr("playground.notice.sent"));
      } else {
        if (!host.workbench.activateProfile("conversation")) {
          throw new Error(tr("playground.error.workChatUnavailable"));
        }
        host.conversation.startNewSession(projectId, {
          title: tr("playground.sessionTitle"),
          draft: brief,
        });
        setNotice(tr("playground.notice.draft"));
      }
    } catch (cause) {
      setError(host.errors.friendly(tr("playground.error.sendToWorkChat"), cause));
    } finally {
      setHandoffBusy(false);
    }
  }, [artifactExists, artifactHtml, handoffBusy, host, projectId, selection, session?.worktreePath, sessionId]);

  const openSource = useCallback(() => {
    if (!projectId || !sessionId) return;
    let artifactPath: string;
    try {
      artifactPath = playgroundArtifactPath(sessionId);
    } catch (cause) {
      setError(host.errors.friendly(tr("playground.error.resolveArtifact"), cause));
      return;
    }
    host.navigation.openResource({
      scheme: "file",
      locator: artifactPath,
      projectId,
      sessionId,
    });
  }, [host.errors, host.navigation, projectId, sessionId]);

  if (!projectId) {
    return (
      <div className="playground-view">
        <EmptyState title={tr("playground.empty.openProject")} description={tr("playground.empty.openProjectBody")} />
      </div>
    );
  }

  const sourceLabel = artifactExists ? tr("playground.status.live") : tr("playground.status.waiting");

  return (
    <div className="playground-view" data-viewport={viewport}>
      <div className="playground-toolbar">
        <div className="playground-status" title={working ? tr("playground.status.agentEditing") : tr("playground.status.liveArtifact")}>
          <span className={"playground-status-dot" + (working ? " is-working" : artifactExists ? " is-live" : "")} />
          <span>{working ? tr("playground.status.updating") : sourceLabel}</span>
        </div>

        <div className="playground-viewport-group" role="group" aria-label={tr("playground.viewportGroup")}>
          {VIEWPORTS.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={viewport === item.id ? "primary" : "quiet"}
              aria-pressed={viewport === item.id}
              onClick={() => setViewport(item.id)}
            >
              {tr(item.label)}
            </Button>
          ))}
        </div>

        <span className="playground-toolbar-spacer" />

        <Button
          size="sm"
          variant={inspectMode ? "primary" : "quiet"}
          disabled={!artifactExists}
          aria-pressed={inspectMode}
          title={tr("playground.select.title")}
          onClick={() => setInspectMode((value) => !value)}
        >
          {tr("playground.select.label")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={handoffBusy}
          disabled={!artifactExists || handoffBusy}
          title={tr("playground.handoff.title")}
          onClick={() => void sendToWorkChat()}
        >
          {tr("playground.handoff.label")}
        </Button>
        <Button
          size="sm"
          variant={networkEnabled ? "primary" : "quiet"}
          aria-pressed={networkEnabled}
          title={tr("playground.network.title")}
          onClick={() => setNetworkEnabled((value) => !value)}
        >
          {tr("playground.network.label", { state: networkEnabled ? tr("playground.network.on") : tr("playground.network.off") })}
        </Button>
        <Button size="sm" variant="quiet" disabled={!artifactExists} onClick={openSource}>{tr("playground.source")}</Button>
        <Button
          size="sm"
          variant="quiet"
          disabled={!sessionId}
          onClick={() => { setPreviewEpoch((value) => value + 1); void refreshArtifact(true); }}
        >
          {tr("playground.reload")}
        </Button>
        {isPlaygroundMode && (
          <Button
            size="sm"
            variant="quiet"
            title={tr("playground.swap.title")}
            onClick={swapPanes}
          >
            {tr("playground.swap")}
          </Button>
        )}
      </div>

      {error && artifactExists && (
        <div className="playground-notice is-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {notice && <div className="playground-notice" role="status">{notice}</div>}

      <div className="playground-stage">
        {loading && !artifactExists ? (
          <div className="playground-empty">
            <EmptyState title={tr("playground.loading.title")} description={tr("playground.loading.body")} />
          </div>
        ) : !artifactExists ? (
          <div className="playground-empty">
            {error ? (
              <EmptyState
                title={tr("playground.empty.previewUnavailable")}
                description={error}
                actionLabel={tr("playground.retry")}
                onAction={() => void refreshArtifact(true)}
              />
            ) : (
              <EmptyState
                title={sessionId ? tr("playground.empty.tellChat") : tr("playground.empty.startChat")}
                description={sessionId
                  ? tr("playground.empty.tellChatBody")
                  : tr("playground.empty.startChatBody")}
                actionLabel={tr("playground.openChat")}
                onAction={() => host.workbench.openSurface("session")}
              />
            )}
          </div>
        ) : (
          <div className="playground-device-shell">
            <iframe
              key={artifactRevision + ":" + previewEpoch + ":" + String(networkEnabled)}
              ref={iframeRef}
              className="playground-frame"
              title={tr("playground.frame.title")}
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
          <Button size="sm" variant="primary" onClick={addSelectionToChat}>{tr("playground.selection.add")}</Button>
          <Button size="sm" variant="quiet" onClick={() => setSelection(null)}>{tr("playground.selection.clear")}</Button>
        </div>
      )}
    </div>
  );
}
