// Shared internal browser: one server-owned page context operated by the user,
// primary agent, and subagents. Revisioned frames stream over /ws; element
// pointing turns screenshot coordinates into durable chat context.
import { useEffect, useRef, useState } from "react";
import { api, type BrowserSessionDto } from "../api.ts";
import { attachUpload, removeAttachment } from "../attachments.ts";
import {
  annotationViewportRect,
  BROWSER_DEVICE_PRESETS,
  browserElementContext,
  containedImageRect,
  devicePresetForViewport,
  normalizedPointInImage,
  normalizedRectInImage,
  renderBrowserCapture,
  type BrowserAnnotation,
  type BrowserDevicePresetId,
  type BrowserPointedElement,
  type ImageRect,
} from "../browserPreview.ts";
import { sendMessage } from "../init.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";
import { usePaneVisible } from "../workspace/paneVisibility.ts";

type InspectorTab = "snapshot" | "console" | "activity";
type ColorScheme = "light" | "dark" | "no-preference";

interface Capability {
  available: boolean;
  engine: "chromium" | "fake" | null;
  reason?: string;
}

export default function PreviewView() {
  const projectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  // Kept alive while hidden: UI-only polling pauses; the canonical browser
  // frame subscription (WebSocket) below stays attached.
  const visible = usePaneVisible();
  const [urlInput, setUrlInput] = useState("");
  const [tab, setTab] = useState<InspectorTab>("console");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cap, setCap] = useState<Capability | null>(null);
  const [browser, setBrowser] = useState<BrowserSessionDto | null>(null);
  const [frame, setFrame] = useState<{ revision: number; src: string } | null>(null);
  const [agentPaused, setAgentPaused] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [consoleLines, setConsoleLines] = useState<Array<{ at: number; level: string; message: string }>>([]);
  const [typeText, setTypeText] = useState("");
  const [snapshotText, setSnapshotText] = useState("");
  const [inspectSelector, setInspectSelector] = useState("");
  const [annotating, setAnnotating] = useState(false);
  const [pointing, setPointing] = useState(false);
  const [pointedElement, setPointedElement] = useState<BrowserPointedElement | null>(null);
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([]);
  const [imageRect, setImageRect] = useState<ImageRect>({ left: 0, top: 0, width: 0, height: 0 });
  const [captureBusy, setCaptureBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const nextAnnotationId = useRef(1);
  const annotationDragStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { void api.browserCapability().then(setCap); }, []);
  useEffect(() => {
    if (!projectId) {
      setBrowser(null);
      return;
    }
    let cancelled = false;
    const adopt = async () => {
      const sessions = await api.browserList(projectId);
      if (cancelled) return;
      const matching = activeSessionId
        ? sessions.find((session) => session.sessionId === activeSessionId)
        : undefined;
      const next = matching ?? sessions.at(-1) ?? null;
      setBrowser((current) => current?.id === next?.id ? current : next);
      if (next) revisionRef.current = 0;
    };
    void adopt();
    if (!visible || browser) return () => { cancelled = true; };
    const timer = setInterval(() => void adopt(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, activeSessionId, visible, browser?.id]);
  useEffect(() => {
    if (browser?.url) setUrlInput(browser.url);
  }, [browser?.url]);
  // Frame stream: subscribe over /ws; reconnect resumes at the last revision.
  useEffect(() => {
    if (!browser) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "browser/subscribe", browserSessionId: browser.id, afterRevision: revisionRef.current }));
      };
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data)) as {
            type: string; revision?: number; mime?: string; data?: string;
            event?: { kind: string; message?: string; url?: string; actor?: string };
          };
          if (msg.type === "browser/frame" && msg.data) {
            const revision = msg.revision ?? 0;
            if (revision !== revisionRef.current) {
              setAnnotations([]);
              setPointedElement(null);
              nextAnnotationId.current = 1;
            }
            revisionRef.current = revision;
            setFrame({ revision, src: `data:${msg.mime};base64,${msg.data}` });
          } else if (msg.type === "browser/event" && msg.event) {
            const e = msg.event;
            setActivity((prev) => [...prev.slice(-99), `${e.kind}${e.actor ? ` (${e.actor})` : ""}${e.url ? ` ${e.url}` : ""}${e.message ? ` — ${e.message}` : ""}`]);
            if (e.kind === "navigation" || e.kind === "closed") {
              void api.browserGet(browser.id).then(setBrowser).catch(() => setBrowser(null));
            }
          }
        } catch { /* not for us */ }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [browser?.id]);

  useEffect(() => {
    const image = imgRef.current;
    if (!image || !browser) return;
    const update = () => {
      setImageRect(containedImageRect(
        image.clientWidth,
        image.clientHeight,
        browser.viewport.width,
        browser.viewport.height,
      ));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(image);
    return () => observer.disconnect();
  }, [browser?.viewport.width, browser?.viewport.height, frame?.revision]);

  // Console poll only while the inspector shows it AND the pane is visible.
  useEffect(() => {
    if (!browser || !inspectorOpen || tab !== "console" || !visible) return;
    const load = () => void api.browserConsole(browser.id).then(setConsoleLines);
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [browser?.id, inspectorOpen, tab, visible]);

  const openBrowser = async () => {
    if (!projectId) return;
    setBusy(true);
    setError("");
    try {
      const dto = await api.browserCreate({
        projectId,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      });
      revisionRef.current = 0;
      setBrowser(dto);
      let opened = dto;
      const requestedUrl = urlInput.trim();
      if (requestedUrl) {
        try {
          opened = await api.browserNavigate(dto.id, requestedUrl, "user");
        } catch (navigationError) {
          const message = String(navigationError);
          if (
            (message.includes("approval-required") || message.includes("needs approval"))
            && window.confirm(`Approve this origin for the internal browser?\n\n${message}`)
          ) {
            await api.browserApprove(requestedUrl);
            opened = await api.browserNavigate(dto.id, requestedUrl, "user");
          } else {
            throw navigationError;
          }
        }
      }
      setBrowser(opened);
      setActivity([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const closeBrowser = async () => {
    if (!browser) return;
    await api.browserClose(browser.id).catch(() => {});
    setBrowser(null);
    setFrame(null);
    setAnnotations([]);
    setAnnotating(false);
    setPointing(false);
    setPointedElement(null);
    revisionRef.current = 0;
  };

  const navigate = async (raw: string) => {
    if (!browser) return;
    setError("");
    try {
      setBrowser(await api.browserNavigate(browser.id, raw, "user"));
    } catch (e) {
      const msg = String(e);
      if (msg.includes("approval-required") || msg.includes("needs")) {
        if (window.confirm(`This origin is outside the allowed list.\n\n${msg}\n\nApprove it for this run?`)) {
          try {
            await api.browserApprove(raw);
            setBrowser(await api.browserNavigate(browser.id, raw, "user"));
            return;
          } catch (e2) {
            setError(String(e2));
            return;
          }
        }
      }
      setError(msg);
    }
  };

  const act = async (action: Parameters<typeof api.browserAction>[1]) => {
    if (!browser) return null;
    setError("");
    try {
      const { session, result } = await api.browserAction(browser.id, action, "user");
      setBrowser(session);
      return result ?? null;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  const takeSnapshot = async (selector?: string) => {
    if (!browser) return;
    setError("");
    try {
      const observation = await api.browserObserve(browser.id, false, selector);
      setSnapshotText([
        `${observation.title || "Untitled"} — ${observation.url}`,
        observation.text,
        observation.accessibilityDigest,
      ].filter(Boolean).join("\n\n"));
      setTab("snapshot");
      setInspectorOpen(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const inspect = async () => {
    const selector = inspectSelector.trim();
    if (!selector) return;
    const result = await act({ kind: "inspect", selector });
    if (result) {
      setSnapshotText(JSON.stringify(result, null, 2));
      setTab("snapshot");
      setInspectorOpen(true);
    }
  };

  const annotationPoint = (clientX: number, clientY: number) => {
    const image = imgRef.current;
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  };

  const updateAnnotationSelection = (end: { x: number; y: number }) => {
    const start = annotationDragStart.current;
    if (!start) return;
    const rect = normalizedRectInImage(start, end, imageRect);
    if (!rect) return;
    setAnnotations((current) => [{
      id: current[0]?.id ?? nextAnnotationId.current++,
      ...rect,
      note: current[0]?.note ?? "",
    }]);
  };

  const beginAnnotation = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!annotating) return;
    const point = annotationPoint(event.clientX, event.clientY);
    if (!point || !normalizedPointInImage(point.x, point.y, imageRect)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    annotationDragStart.current = point;
    setAnnotations([]);
  };

  const moveAnnotation = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!annotating || !annotationDragStart.current) return;
    const point = annotationPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    updateAnnotationSelection(point);
  };

  const endAnnotation = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!annotating || !annotationDragStart.current) return;
    const point = annotationPoint(event.clientX, event.clientY);
    if (point) updateAnnotationSelection(point);
    annotationDragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const pointAtFrame = async (x: number, y: number) => {
    if (!browser || !frame) return;
    const result = await act({
      kind: "point",
      target: { point: { x, y }, frameRevision: frame.revision },
    });
    if (!result) return;
    const element = result as unknown as BrowserPointedElement;
    if (!element.selector || !element.tag || !element.rect) {
      setError("The browser could not identify an element at that point.");
      return;
    }
    setPointedElement(element);
    const rect = element.rect;
    setAnnotations([{
      id: nextAnnotationId.current++,
      x: Math.max(0, rect.x) / browser.viewport.width,
      y: Math.max(0, rect.y) / browser.viewport.height,
      width: Math.min(browser.viewport.width - Math.max(0, rect.x), Math.max(1, rect.width)) / browser.viewport.width,
      height: Math.min(browser.viewport.height - Math.max(0, rect.y), Math.max(1, rect.height)) / browser.viewport.height,
      note: "",
    }]);
    setPointing(false);
    setAnnotating(false);
  };

  const captureToChat = async () => {
    if (!browser || !projectId || !activeSessionId) return;
    const annotation = annotations[0];
    const comment = annotation?.note.trim() ?? "";
    if (!pointedElement && (!annotation || annotation.width <= 0 || annotation.height <= 0 || !comment)) return;
    const targetProjectId = projectId;
    const targetSessionId = activeSessionId;
    setCaptureBusy(true);
    setError("");
    try {
      const observation = await api.browserObserve(browser.id, true);
      if (!observation.screenshot) throw new Error("The browser returned no capture.");
      const source = `data:${observation.screenshot.mime};base64,${observation.screenshot.data}`;
      const file = await renderBrowserCapture(
        source,
        annotation ? [{ ...annotation, note: comment }] : [],
      );
      const attached = await attachUpload(targetProjectId, targetSessionId, file);
      if (!attached.ok) throw new Error(attached.reason);
      const elementContext = pointedElement ? browserElementContext(browser.url, pointedElement) : "";
      const message = [comment, elementContext].filter(Boolean).join("\n\n");
      const sent = await sendMessage(message, undefined, undefined, {
        targetSessionId,
        attachments: [attached.ref],
      });
      if (!sent) {
        throw new Error("The annotated screenshot is attached to the draft, but the message was not sent.");
      }
      removeAttachment(targetSessionId, attached.ref.id);
      const selected = annotationViewportRect(annotation, browser.viewport);
      setSnapshotText(
        `Sent ${attached.ref.name} to chat with the selected ${selected.width}×${selected.height} area.`,
      );
      setTab("snapshot");
      setInspectorOpen(true);
      setAnnotations([]);
      setAnnotating(false);
      setPointing(false);
      setPointedElement(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setCaptureBusy(false);
    }
  };

  const clickFrame = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!browser || !frame || !imgRef.current) return;
    const elementRect = imgRef.current.getBoundingClientRect();
    const visibleImage = containedImageRect(
      elementRect.width,
      elementRect.height,
      browser.viewport.width,
      browser.viewport.height,
    );
    const point = normalizedPointInImage(
      e.clientX - elementRect.left,
      e.clientY - elementRect.top,
      visibleImage,
    );
    if (!point) return;
    if (annotating) return;
    const x = Math.round(point.x * browser.viewport.width);
    const y = Math.round(point.y * browser.viewport.height);
    if (pointing) {
      void pointAtFrame(x, y);
      return;
    }
    // the click carries the frame revision it was aimed at (stale clicks 409)
    void act({ kind: "click", target: { point: { x, y }, frameRevision: frame.revision } });
  };

  const togglePause = async () => {
    if (!browser) return;
    const next = !agentPaused;
    await api.browserPauseAgent(browser.id, next).catch(() => {});
    setAgentPaused(next);
  };

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to use the internal browser." />;

  const browserMode = !!browser && browser.status !== "closed";

  return (
    <div className="preview-view">
      <div className="browser-chrome browser-toolbar">
        {browserMode && (
          <span className="browser-history">
            <button className="small-btn" title="Back" aria-label="Back" onClick={() => void act({ kind: "back" })}>←</button>
            <button className="small-btn" title="Forward" aria-label="Forward" onClick={() => void act({ kind: "forward" })}>→</button>
            <button className="small-btn" title="Reload" aria-label="Reload" onClick={() => void act({ kind: "reload" })}>↻</button>
          </span>
        )}
        <form
          className="url-pill browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            if (browserMode) void navigate(urlInput);
            else void openBrowser();
          }}
        >
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="localhost:5173"
            aria-label="Address"
          />
        </form>
        {browserMode && browser.url !== "about:blank" && (
          <a className="small-btn" href={browser.url} target="_blank" rel="noreferrer" title="Open in a new tab">↗</a>
        )}
        {cap?.available && !browserMode && (
          <button className="primary-btn" onClick={() => void openBrowser()} disabled={busy} title="Open a browser shared with all agents">
            {busy ? "Opening…" : "Open browser"}
          </button>
        )}
        {browserMode && (
          <>
            <select
              className="browser-device"
              aria-label="Browser device preset"
              value={devicePresetForViewport(browser.viewport.width, browser.viewport.height)}
              onChange={(event) => {
                const preset = BROWSER_DEVICE_PRESETS.find(
                  (candidate) => candidate.id === event.target.value as BrowserDevicePresetId,
                );
                if (preset) void act({ kind: "resize", viewport: { width: preset.width, height: preset.height } });
              }}
            >
              {BROWSER_DEVICE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label} · {preset.width}×{preset.height}
                </option>
              ))}
            </select>
            <select
              className="browser-scheme"
              aria-label="Emulated color scheme"
              value={browser.colorScheme}
              onChange={(event) => void act({
                kind: "color-scheme",
                colorScheme: event.target.value as ColorScheme,
              })}
            >
              <option value="no-preference">Scheme: default</option>
              <option value="light">Scheme: light</option>
              <option value="dark">Scheme: dark</option>
            </select>
            <button className="small-btn" onClick={() => void takeSnapshot()} title="Read visible text and accessibility details">Snapshot</button>
            <button
              className={`small-btn ${annotating ? "active" : ""}`}
              aria-pressed={annotating}
              onClick={() => {
                setAnnotating((current) => !current);
                setPointing(false);
                setAnnotations([]);
                setPointedElement(null);
              }}
              title="Select an area of the current frame and comment on it"
            >
              Annotate
            </button>
            <button
              className={`small-btn ${pointing ? "active" : ""}`}
              aria-pressed={pointing}
              onClick={() => {
                setPointing((current) => !current);
                setAnnotating(false);
                setAnnotations([]);
                setPointedElement(null);
              }}
              title="Point at a page element and add its DOM context to chat"
            >
              Point
            </button>
            <button className="small-btn" aria-pressed={agentPaused} onClick={() => void togglePause()} title="Pause or resume agent control of this browser">
              {agentPaused ? "Resume agent" : "Pause agent"}
            </button>
            <button className="small-btn danger-btn" onClick={() => void closeBrowser()} title="Close the browser session (context, cookies, and storage are destroyed)">
              Close
            </button>
          </>
        )}
        <button
          className="small-btn"
          aria-pressed={inspectorOpen}
          title="Toggle inspector"
          onClick={() => setInspectorOpen((v) => !v)}
        >
          Inspector
        </button>
      </div>
      {cap && !cap.available && (
        <div className="browser-unavailable" role="note">
          Internal browser unavailable. {cap.reason}
        </div>
      )}
      {error && <div className="form-error" style={{ padding: "6px 12px" }}>{error}</div>}
      <div className="preview-body">
        <div className="preview-stage browser-viewport">
          {browserMode ? (
            frame ? (
              <div className="browser-frame-wrap">
                <div className="browser-frame-stage">
                  <img
                    ref={imgRef}
                    src={frame.src}
                    alt={`Browser: ${browser?.title || browser?.url || ""}`}
                    className={`browser-frame-img ${annotating ? "annotating" : ""} ${pointing ? "pointing" : ""}`}
                    draggable={false}
                    onClick={clickFrame}
                    onPointerDown={beginAnnotation}
                    onPointerMove={moveAnnotation}
                    onPointerUp={endAnnotation}
                    onPointerCancel={() => { annotationDragStart.current = null; }}
                    onLoad={(event) => setImageRect(containedImageRect(
                      event.currentTarget.clientWidth,
                      event.currentTarget.clientHeight,
                      browser.viewport.width,
                      browser.viewport.height,
                    ))}
                  />
                  <div className="browser-annotation-layer" aria-label="Browser annotations">
                    {annotations.map((annotation, index) => annotation.width > 0 && annotation.height > 0 ? (
                      <div
                        key={annotation.id}
                        className="browser-annotation-box"
                        style={{
                          left: imageRect.left + annotation.x * imageRect.width,
                          top: imageRect.top + annotation.y * imageRect.height,
                          width: annotation.width * imageRect.width,
                          height: annotation.height * imageRect.height,
                        }}
                        aria-label={`Annotation ${index + 1}${annotation.note ? `: ${annotation.note}` : ""}`}
                        role="img"
                      >
                        <span>{index + 1}</span>
                      </div>
                    ) : null)}
                  </div>
                </div>
                <div className="browser-frame-bar">
                  <span className="mono">{browser?.url}</span>
                  <span className="muted">
                    rev {frame.revision} · {browser?.engine} · {browser.viewport.width}×{browser.viewport.height}
                  </span>
                  <input
                    value={typeText}
                    onChange={(e) => setTypeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && typeText) {
                        e.preventDefault();
                        void act({ kind: "type", target: { selector: "input, textarea" }, text: typeText, submit: true });
                        setTypeText("");
                      }
                    }}
                    placeholder="Type into the focused field…"
                    aria-label="Type into the page"
                  />
                </div>
                {(annotating || pointing || annotations.length > 0) && (
                  <div className="browser-annotation-editor">
                    <div className="browser-annotation-header">
                      <span aria-live="polite">
                        {pointedElement
                          ? `Pointed at <${pointedElement.tag}> · ${pointedElement.selector}`
                          : pointing
                            ? "Click any element in the page to identify it."
                            : annotations[0]?.width
                              ? `Selected ${annotationViewportRect(annotations[0], browser.viewport).width}×${annotationViewportRect(annotations[0], browser.viewport).height}`
                              : "Drag a rectangle over the browser, then add a comment."}
                      </span>
                      {!pointing && !annotations[0]?.width && (
                        <button
                          className="small-btn"
                          onClick={() => setAnnotations([{
                            id: nextAnnotationId.current++,
                            x: 0.25,
                            y: 0.25,
                            width: 0.5,
                            height: 0.5,
                            note: "",
                          }])}
                        >
                          Select center area
                        </button>
                      )}
                    </div>
                    <div className="browser-annotation-row">
                      <label className="sr-only" htmlFor="browser-annotation-comment">Annotation comment</label>
                      <input
                        id="browser-annotation-comment"
                        value={annotations[0]?.note ?? ""}
                        maxLength={4000}
                        disabled={!annotations[0]?.width}
                        onChange={(event) => setAnnotations((current) =>
                          current[0] ? [{ ...current[0], note: event.target.value }] : current)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && (pointedElement || annotations[0]?.note.trim())) {
                            event.preventDefault();
                            void captureToChat();
                          }
                        }}
                        placeholder={pointedElement ? "Optional instruction about this element…" : "Comment on this area…"}
                      />
                      <button
                        className="primary-btn"
                        disabled={captureBusy || !activeSessionId || (!pointedElement && !annotations[0]?.note.trim())}
                        onClick={() => void captureToChat()}
                        title={activeSessionId ? "Send the annotated screenshot to the active chat" : "Open a chat session first"}
                      >
                        {captureBusy ? "Sending…" : "Send to chat"}
                      </button>
                      <button
                        className="small-btn"
                        disabled={captureBusy}
                        onClick={() => {
                          setAnnotations([]);
                          setAnnotating(false);
                          setPointing(false);
                          setPointedElement(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState title="Connecting to browser" description="Waiting for the first controlled-browser frame." />
            )
          ) : (
            <EmptyState
              title="Internal browser"
              description="Open any HTTP(S) page in a browser shared with the active agent and its subagents."
              actionLabel={cap?.available ? "Open browser" : undefined}
              onAction={cap?.available ? () => void openBrowser() : undefined}
            />
          )}
        </div>
        {inspectorOpen && (
          <aside className="inspector browser-inspector">
            <div className="inspector-tabs">
              {(["snapshot", "console", "activity"] as const).map((t) => (
                <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                  {t[0]!.toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="inspector-body">
              <div className="stat-row"><span className="k">URL</span><span className="mono">{browser?.url ?? "—"}</span></div>
              <div className="stat-row"><span className="k">Status</span><span>{browser?.status ?? "closed"}</span></div>
              {browserMode && <div className="stat-row"><span className="k">Engine</span><span>{browser?.engine}{agentPaused ? " · agent paused" : ""}</span></div>}
              {tab === "snapshot" && (
                browserMode ? (
                  <div className="browser-snapshot">
                    <div className="browser-inspect-controls">
                      <input
                        value={inspectSelector}
                        onChange={(event) => setInspectSelector(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void inspect();
                          }
                        }}
                        placeholder="CSS selector to snapshot or inspect"
                        aria-label="CSS selector"
                      />
                      <button className="small-btn" onClick={() => void takeSnapshot(inspectSelector.trim() || undefined)}>Read</button>
                      <button className="small-btn" disabled={!inspectSelector.trim()} onClick={() => void inspect()}>Inspect</button>
                    </div>
                    <pre>{snapshotText || "Choose Snapshot to read the page, or enter a selector to inspect one element."}</pre>
                  </div>
                ) : (
                  <div className="muted">Snapshots need the controlled browser.</div>
                )
              )}
              {tab === "console" && (
                browserMode ? (
                  <div className="browser-console" role="log">
                    {consoleLines.length === 0 && <div className="muted">No console output yet.</div>}
                    {consoleLines.map((l, i) => (
                      <div key={i} className={`browser-console-line ${l.level}`}>
                        <span className="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.message}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted">Console capture needs the controlled browser.</div>
                )
              )}
              {tab === "activity" && (
                browserMode ? (
                  <div className="browser-console" role="log">
                    {activity.length === 0 && <div className="muted">No agent/browser activity yet.</div>}
                    {activity.map((a, i) => <div key={i} className="browser-console-line">{a}</div>)}
                  </div>
                ) : (
                  <div className="muted">Activity needs the controlled browser.</div>
                )
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
