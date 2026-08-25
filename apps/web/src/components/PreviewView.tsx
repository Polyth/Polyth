// Shared internal browser: one server-owned page context operated by the user,
// primary agent, and subagents. Revisioned frames stream over /ws; element
// pointing turns screenshot coordinates into durable chat context.
import { useEffect, useId, useRef, useState } from "react";
import { api, type BrowserSessionDto } from "../api.ts";
import { attachUpload, removeAttachment } from "../attachments.ts";
import {
  annotationViewportRect,
  BROWSER_DEVICE_PRESETS,
  BROWSER_INSPECTOR_TABS,
  browserApprovalRequired,
  browserElementContext,
  browserInspectorTabFromKey,
  browserPointedElementLabel,
  containedImageRect,
  devicePresetForViewport,
  normalizedPointInImage,
  normalizedRectInImage,
  renderBrowserCapture,
  type BrowserAnnotation,
  type BrowserDevicePresetId,
  type BrowserInspectorTab,
  type BrowserPointedElement,
  type ImageRect,
} from "../browserPreview.ts";
import { sendMessage } from "../init.ts";
import { useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";
import { usePaneVisible } from "../workspace/paneVisibility.ts";
import Dialog from "./a11y/Dialog.tsx";
import { Icon } from "../icons.tsx";
import { friendlyError } from "../settings.ts";
import { getLocale, tr } from "../i18n/index.ts";

type ColorScheme = "light" | "dark" | "no-preference";
type BrowserConnection = "idle" | "connecting" | "connected" | "reconnecting";

interface ApprovalRequest {
  url: string;
  message: string;
}

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
  const [tab, setTab] = useState<BrowserInspectorTab>("console");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
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
  const [connection, setConnection] = useState<BrowserConnection>("idle");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [approvalError, setApprovalError] = useState("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const inspectorButtonRef = useRef<HTMLButtonElement>(null);
  const nextAnnotationId = useRef(1);
  const annotationDragStart = useRef<{ x: number; y: number } | null>(null);
  const approvalDescriptionId = useId();
  const frameStatusId = useId();
  const inspectorId = useId();
  const inspectorPanelId = useId();
  const inspectorTabId = (item: BrowserInspectorTab) => `${inspectorId}-${item}`;

  useEffect(() => {
    let cancelled = false;
    void api.browserCapability()
      .then((value) => { if (!cancelled) setCap(value); })
      .catch((cause) => {
        if (!cancelled) {
          setCap({
            available: false,
            engine: null,
            reason: friendlyError(tr("previewview.couldnTCheckBrowserAvailability"), cause),
          });
        }
      });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!projectId) {
      setBrowser(null);
      return;
    }
    let cancelled = false;
    const adopt = async () => {
      try {
        const sessions = await api.browserList(projectId);
        if (cancelled) return;
        const matching = activeSessionId
          ? sessions.find((session) => session.sessionId === activeSessionId)
          : undefined;
        const next = matching ?? sessions.at(-1) ?? null;
        setBrowser((current) => current?.id === next?.id ? current : next);
        if (next) revisionRef.current = 0;
      } catch (cause) {
        if (!cancelled) setError(friendlyError(tr("previewview.couldnTRestoreTheBrowser"), cause));
      }
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
    if (!browser) {
      setConnection("idle");
      return;
    }
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      setConnection(revisionRef.current > 0 ? "reconnecting" : "connecting");
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnection("connected");
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
        if (!closed) {
          setConnection("reconnecting");
          retry = setTimeout(connect, 1000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      setConnection("idle");
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
    if (!projectId || !cap?.available || operation) return;
    setOperation("open");
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
          if (browserApprovalRequired(navigationError)) {
            setApproval({
              url: requestedUrl,
              message: navigationError instanceof Error ? navigationError.message : String(navigationError),
            });
            setApprovalError("");
          } else {
            throw navigationError;
          }
        }
      }
      setBrowser(opened);
      setActivity([]);
    } catch (e) {
      setError(friendlyError(tr("previewview.couldnTOpenTheBrowser"), e));
    } finally {
      setOperation(null);
    }
  };

  const closeBrowser = async () => {
    if (!browser || operation) return;
    setOperation("close");
    setError("");
    try {
      await api.browserClose(browser.id);
      setBrowser(null);
      setFrame(null);
      setAnnotations([]);
      setAnnotating(false);
      setPointing(false);
      setPointedElement(null);
      setInspectorOpen(false);
      setCloseConfirmOpen(false);
      revisionRef.current = 0;
    } catch (cause) {
      setError(friendlyError(tr("previewview.couldnTCloseTheBrowser"), cause));
    } finally {
      setOperation(null);
    }
  };

  const navigate = async (raw: string) => {
    const requestedUrl = raw.trim();
    if (!browser || operation) return;
    if (!requestedUrl) {
      setError(tr("previewview.enterAnHttpSAddressToNavigate"));
      return;
    }
    setOperation("navigate");
    setError("");
    try {
      setBrowser(await api.browserNavigate(browser.id, requestedUrl, "user"));
    } catch (e) {
      if (browserApprovalRequired(e)) {
        setApproval({
          url: requestedUrl,
          message: e instanceof Error ? e.message : String(e),
        });
        setApprovalError("");
        return;
      }
      setError(friendlyError(tr("previewview.navigationFailed"), e));
    } finally {
      setOperation(null);
    }
  };

  const approveNavigation = async () => {
    if (!approval || !browser || operation) return;
    setOperation("approve");
    setApprovalError("");
    try {
      await api.browserApprove(approval.url);
      setBrowser(await api.browserNavigate(browser.id, approval.url, "user"));
      setApproval(null);
    } catch (cause) {
      setApprovalError(friendlyError(tr("previewview.couldnTApproveThisOrigin"), cause));
    } finally {
      setOperation(null);
    }
  };

  const act = async (action: Parameters<typeof api.browserAction>[1]) => {
    if (!browser || operation) return { ok: false, result: null };
    setOperation(action.kind);
    setError("");
    try {
      const { session, result } = await api.browserAction(browser.id, action, "user");
      setBrowser(session);
      return { ok: true, result: result ?? null };
    } catch (e) {
      setError(friendlyError(tr("previewview.browserActionFailed"), e));
      return { ok: false, result: null };
    } finally {
      setOperation(null);
    }
  };

  const takeSnapshot = async (selector?: string) => {
    if (!browser || operation) return;
    setOperation("snapshot");
    setError("");
    try {
      const observation = await api.browserObserve(browser.id, false, selector);
      setSnapshotText([
        `${observation.title || tr("previewview.untitled")} — ${observation.url}`,
        observation.text,
        observation.accessibilityDigest,
      ].filter(Boolean).join("\n\n"));
      setTab("snapshot");
      setInspectorOpen(true);
    } catch (e) {
      setError(friendlyError(tr("previewview.couldnTReadThePage"), e));
    } finally {
      setOperation(null);
    }
  };

  const inspect = async () => {
    const selector = inspectSelector.trim();
    if (!selector) return;
    const outcome = await act({ kind: "inspect", selector });
    if (outcome.ok && outcome.result) {
      setSnapshotText(JSON.stringify(outcome.result, null, 2));
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
    const outcome = await act({
      kind: "point",
      target: { point: { x, y }, frameRevision: frame.revision },
    });
    if (!outcome.ok || !outcome.result) return;
    const element = outcome.result as unknown as BrowserPointedElement;
    if (!element.selector || !element.tag || !element.rect) {
      setError(tr("previewview.theBrowserCouldNotIdentify"));
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

  const clearSelection = () => {
    setAnnotations([]);
    setAnnotating(false);
    setPointing(false);
    setPointedElement(null);
    annotationDragStart.current = null;
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
      if (!observation.screenshot) throw new Error(tr("previewview.theBrowserReturnedNoCapture"));
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
        throw new Error(tr("previewview.theAnnotatedScreenshotIsAttached"));
      }
      removeAttachment(targetSessionId, attached.ref.id);
      const selected = annotation ? annotationViewportRect(annotation, browser.viewport) : null;
      setSnapshotText(selected
        ? tr("previewview.sentValueToChatWithSelectedArea", { name: attached.ref.name, width: selected.width, height: selected.height })
        : tr("previewview.sentValueAndBrowserElementContext", { name: attached.ref.name }));
      setTab("snapshot");
      setInspectorOpen(true);
      setAnnotations([]);
      setAnnotating(false);
      setPointing(false);
      setPointedElement(null);
    } catch (e) {
      setError(friendlyError(tr("previewview.couldnTSendTheBrowserCapture"), e));
    } finally {
      setCaptureBusy(false);
    }
  };

  const clickFrame = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!browser || !frame || !imgRef.current || operation) return;
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
    if (!browser || operation) return;
    const next = !agentPaused;
    setOperation(next ? "pause" : "resume");
    setError("");
    try {
      await api.browserPauseAgent(browser.id, next);
      setAgentPaused(next);
    } catch (cause) {
      setError(friendlyError(next ? tr("previewview.couldnTPauseAgentControl") : tr("previewview.couldnTResumeAgentControl"), cause));
    } finally {
      setOperation(null);
    }
  };

  const typeFocusedField = async (submit: boolean) => {
    const text = typeText;
    if (!text || operation) return;
    const outcome = await act({
      kind: "type",
      target: { selector: ":focus" },
      text,
      submit,
    });
    if (outcome.ok) setTypeText("");
  };

  const activateFrameFromKeyboard = (event: React.KeyboardEvent<HTMLImageElement>) => {
    if (!browser || !frame || operation || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    const x = Math.round(browser.viewport.width / 2);
    const y = Math.round(browser.viewport.height / 2);
    if (pointing) {
      void pointAtFrame(x, y);
    } else if (!annotating) {
      void act({ kind: "click", target: { point: { x, y }, frameRevision: frame.revision } });
    }
  };

  if (!projectId) return <EmptyState title={tr("previewview.noProjectSelected")} description={tr("previewview.openAProjectToUseTheInternalBrowser")} />;

  const browserMode = !!browser && browser.status !== "closed";
  const busy = operation !== null || captureBusy;
  const connectionLabel: Record<BrowserConnection, string> = {
    idle: tr("previewview.disconnected"),
    connecting: tr("previewview.connecting"),
    connected: agentPaused ? tr("previewview.agentPaused") : tr("previewview.live"),
    reconnecting: tr("previewview.reconnecting"),
  };
  let approvalOrigin = approval?.url ?? "";
  if (approval) {
    try {
      const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(approval.url)
        ? approval.url
        : `http://${approval.url}`;
      approvalOrigin = new URL(raw).origin;
    } catch {
      // Keep the user-entered address visible when URL parsing fails.
    }
  }

  return (
    <>
      <div
        className="preview-view"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (annotating || pointing || annotations.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              clearSelection();
            } else if (inspectorOpen) {
              event.preventDefault();
              event.stopPropagation();
              setInspectorOpen(false);
              requestAnimationFrame(() => inspectorButtonRef.current?.focus());
            }
          }
        }}
      >
        <div className="browser-chrome browser-toolbar" aria-label={tr("previewview.browserControls")}>
          <div className="browser-navigation-row">
            {browserMode && (
              <span className="browser-history" role="group" aria-label={tr("previewview.pageHistory")}>
                <button
                  type="button"
                  className="browser-icon-btn"
                  title={tr("common.back")}
                  aria-label={tr("common.back")}
                  disabled={busy}
                  onClick={() => void act({ kind: "back" })}
                >
                  <Icon.back />
                </button>
                <button
                  type="button"
                  className="browser-icon-btn browser-forward"
                  title={tr("previewview.forward")}
                  aria-label={tr("previewview.forward")}
                  disabled={busy}
                  onClick={() => void act({ kind: "forward" })}
                >
                  <Icon.back />
                </button>
                <button
                  type="button"
                  className="browser-icon-btn"
                  title={tr("previewview.reload")}
                  aria-label={tr("previewview.reload")}
                  disabled={busy}
                  onClick={() => void act({ kind: "reload" })}
                >
                  <Icon.refresh />
                </button>
              </span>
            )}
            <form
              className="url-pill browser-address"
              aria-label={tr("previewview.browserAddress")}
              onSubmit={(event) => {
                event.preventDefault();
                if (browserMode) void navigate(urlInput);
                else void openBrowser();
              }}
            >
              <span className="browser-address-icon" aria-hidden="true"><Icon.globe /></span>
              <input
                ref={addressInputRef}
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                placeholder="https://example.com"
                aria-label={tr("previewview.address")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                disabled={!browserMode && cap?.available !== true}
              />
              <button
                type="submit"
                className="browser-address-submit"
                aria-label={browserMode ? tr("previewview.navigate") : tr("previewview.openBrowser")}
                title={browserMode ? tr("previewview.navigate") : tr("previewview.openBrowser")}
                disabled={busy || (!browserMode && cap?.available !== true)}
              >
                {operation === "navigate" || operation === "open"
                  ? <span className="browser-spinner" aria-hidden="true" />
                  : <Icon.chevronRight />}
              </button>
            </form>
            {browserMode && browser.url !== "about:blank" && (
              <a
                className="browser-icon-btn"
                href={browser.url}
                target="_blank"
                rel="noreferrer"
                title={tr("previewview.openPageInANewTab")}
                aria-label={tr("previewview.openPageInANewTab")}
              >
                <Icon.link />
              </a>
            )}
          </div>

          {browserMode && (
            <div className="browser-tools-row" aria-label={tr("previewview.browserTools")}>
              <select
                className="browser-device"
                aria-label={tr("previewview.browserDevicePreset")}
                title={tr("previewview.viewportSize")}
                disabled={busy}
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
                aria-label={tr("previewview.emulatedColorScheme")}
                title={tr("previewview.emulatedColorScheme")}
                disabled={busy}
                value={browser.colorScheme}
                onChange={(event) => void act({
                  kind: "color-scheme",
                  colorScheme: event.target.value as ColorScheme,
                })}
              >
                <option value="no-preference">{tr("previewview.systemTheme")}</option>
                <option value="light">{tr("previewview.lightTheme")}</option>
                <option value="dark">{tr("previewview.darkTheme")}</option>
              </select>
              <span className="browser-tool-divider" aria-hidden="true" />
              <button
                type="button"
                className="browser-tool-btn"
                aria-label={tr("previewview.snapshot")}
                disabled={busy}
                onClick={() => void takeSnapshot()}
                title={tr("previewview.readVisibleTextAndAccessibility")}
              >
                <Icon.image /><span>{tr("previewview.snapshot")}</span>
              </button>
              <button
                type="button"
                className={`browser-tool-btn${annotating ? " active" : ""}`}
                aria-label={tr("previewview.annotate")}
                aria-pressed={annotating}
                disabled={busy}
                onClick={() => {
                  const next = !annotating;
                  clearSelection();
                  setAnnotating(next);
                }}
                title={tr("previewview.selectAnAreaOfTheCurrentFrame")}
              >
                <Icon.focus /><span>{tr("previewview.annotate")}</span>
              </button>
              <button
                type="button"
                className={`browser-tool-btn${pointing ? " active" : ""}`}
                aria-label={tr("previewview.point")}
                aria-pressed={pointing}
                disabled={busy}
                onClick={() => {
                  const next = !pointing;
                  clearSelection();
                  setPointing(next);
                }}
                title={tr("previewview.pointAtAPageElementAnd")}
              >
                <Icon.target /><span>{tr("previewview.point")}</span>
              </button>
              <button
                type="button"
                className={`browser-tool-btn${agentPaused ? " active" : ""}`}
                aria-label={agentPaused ? tr("previewview.resumeAgent") : tr("previewview.pauseAgent")}
                aria-pressed={agentPaused}
                disabled={busy}
                onClick={() => void togglePause()}
                title={tr("previewview.pauseOrResumeAgentControl")}
              >
                {agentPaused ? <Icon.refresh /> : <Icon.stop />}
                <span>{agentPaused ? tr("previewview.resume") : tr("previewview.pauseAgent")}</span>
              </button>
              <button
                ref={inspectorButtonRef}
                type="button"
                className={`browser-tool-btn${inspectorOpen ? " active" : ""}`}
                aria-label={tr("previewview.inspector")}
                aria-pressed={inspectorOpen}
                aria-controls={inspectorId}
                disabled={busy}
                title={tr("previewview.toggleBrowserInspector")}
                onClick={() => setInspectorOpen((value) => !value)}
              >
                <Icon.sliders /><span>{tr("previewview.inspector")}</span>
              </button>
              <button
                type="button"
                className="browser-tool-btn danger-btn"
                aria-label={tr("common.close")}
                disabled={busy}
                onClick={() => setCloseConfirmOpen(true)}
                title={tr("previewview.closeTheBrowserSession")}
              >
                <Icon.close /><span>{tr("common.close")}</span>
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="browser-alert" role="alert">
            <Icon.shield />
            <span>{error}</span>
            <button type="button" aria-label={tr("previewview.dismissBrowserError")} onClick={() => setError("")}>
              <Icon.close />
            </button>
          </div>
        )}

        <div className="preview-body">
          <div className="preview-stage browser-viewport" aria-busy={operation === "open" || operation === "navigate"}>
            {browserMode ? (
              frame ? (
                <div className="browser-frame-wrap">
                  <div className={`browser-frame-stage${pointing ? " is-pointing" : ""}${annotating ? " is-annotating" : ""}`}>
                    <img
                      ref={imgRef}
                      src={frame.src}
                      alt={tr("previewview.interactiveBrowserFrameValue", { title: browser.title || browser.url || tr("previewview.untitledPage") })}
                      className={`browser-frame-img${annotating ? " annotating" : ""}${pointing ? " pointing" : ""}`}
                      aria-describedby={frameStatusId}
                      role="button"
                      tabIndex={0}
                      draggable={false}
                      onClick={clickFrame}
                      onKeyDown={activateFrameFromKeyboard}
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
                    {(annotating || pointing) && (
                      <div className="browser-frame-mode" role="status">
                        {operation === "point"
                          ? <><span className="browser-spinner" aria-hidden="true" /> {tr("previewview.identifyingElement")}</>
                          : pointing
                            ? <><Icon.target /> {tr("previewview.selectAnElement")}</>
                            : <><Icon.focus /> {tr("previewview.dragToSelectAnArea")}</>}
                        <kbd>Esc</kbd>
                      </div>
                    )}
                    <div className="browser-annotation-layer" aria-label={tr("previewview.browserAnnotations")}>
                      {annotations.map((annotation, index) => annotation.width > 0 && annotation.height > 0 ? (
                        <div
                          key={annotation.id}
                          className={`browser-annotation-box${pointedElement ? " pointed" : ""}`}
                          style={{
                            left: imageRect.left + annotation.x * imageRect.width,
                            top: imageRect.top + annotation.y * imageRect.height,
                            width: annotation.width * imageRect.width,
                            height: annotation.height * imageRect.height,
                          }}
                          aria-label={`${pointedElement ? tr("previewview.pointedElement") : tr("previewview.annotation")} ${index + 1}${annotation.note ? `: ${annotation.note}` : ""}`}
                          role="img"
                        >
                          <span>{pointedElement ? <Icon.target /> : index + 1}</span>
                        </div>
                      ) : null)}
                    </div>
                  </div>

                  <div className="browser-frame-bar" id={frameStatusId}>
                    <div className="browser-frame-info">
                      <span className={`browser-live-dot ${agentPaused ? "paused" : connection}`} aria-hidden="true" />
                      <span className="browser-frame-title" title={browser.title || browser.url}>
                        {browser.title || tr("previewview.untitledPage")}
                      </span>
                      <span className="browser-frame-meta" title={`${browser.engine} · revision ${frame.revision}`}>
                        {connectionLabel[connection]} · {browser.viewport.width}×{browser.viewport.height}
                      </span>
                    </div>
                    <form
                      className="browser-type-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void typeFocusedField(true);
                      }}
                    >
                      <input
                        value={typeText}
                        onChange={(event) => setTypeText(event.target.value)}
                        placeholder={tr("previewview.typeInTheFocusedPageField")}
                        aria-label={tr("previewview.typeIntoTheFocusedPageField")}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="browser-type-button"
                        disabled={busy || !typeText}
                        onClick={() => void typeFocusedField(false)}
                        title={tr("previewview.typeWithoutSubmitting")}
                      >
                        {tr("previewview.type")}
                      </button>
                    </form>
                  </div>

                  {(annotating || pointing || annotations.length > 0) && (
                    <div className="browser-annotation-editor">
                      <div className="browser-annotation-header">
                        <span aria-live="polite">
                          {pointedElement
                            ? <>{tr("previewview.selected")} <code>{`<${pointedElement.tag}>`}</code> · {browserPointedElementLabel(pointedElement)}</>
                            : pointing
                              ? tr("previewview.chooseAnElementInThePagePreview")
                              : annotations[0]?.width
                                ? tr("previewview.selectedValueArea", { width: annotationViewportRect(annotations[0], browser.viewport).width, height: annotationViewportRect(annotations[0], browser.viewport).height })
                                : tr("previewview.dragOverThePagePreview")}
                        </span>
                        {!pointing && !annotations[0]?.width && (
                          <button
                            type="button"
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
                            {tr("previewview.selectCenter")}
                          </button>
                        )}
                      </div>
                      <div className="browser-annotation-row">
                        <label className="sr-only" htmlFor="browser-annotation-comment">{tr("previewview.annotationComment")}</label>
                        <input
                          id="browser-annotation-comment"
                          value={annotations[0]?.note ?? ""}
                          maxLength={4000}
                          disabled={!annotations[0]?.width || captureBusy}
                          onChange={(event) => setAnnotations((current) =>
                            current[0] ? [{ ...current[0], note: event.target.value }] : current)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && (pointedElement || annotations[0]?.note.trim())) {
                              event.preventDefault();
                              void captureToChat();
                            }
                          }}
                          placeholder={pointedElement ? tr("previewview.optionalInstructionAboutThisElement") : tr("previewview.commentOnThisArea")}
                        />
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={captureBusy || !activeSessionId || (!pointedElement && !annotations[0]?.note.trim())}
                          onClick={() => void captureToChat()}
                          title={activeSessionId ? tr("previewview.sendTheAnnotatedScreenshot") : tr("previewview.openAChatSessionFirst")}
                        >
                          {captureBusy ? tr("previewview.sending") : tr("previewview.sendToChat")}
                        </button>
                        <button type="button" className="small-btn" disabled={captureBusy} onClick={clearSelection}>
                          {tr("common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : browser.status === "failed" ? (
                <EmptyState
                  title={tr("previewview.browserStopped")}
                  description={tr("previewview.theControlledBrowserCouldNot")}
                  mark={<Icon.shield />}
                />
              ) : (
                <EmptyState
                  title={connection === "reconnecting" ? tr("previewview.reconnectingToBrowser") : tr("previewview.connectingToBrowser")}
                  description={tr("previewview.waitingForTheFirstSecure")}
                  mark={<span className="browser-spinner browser-spinner-large" />}
                />
              )
            ) : cap === null ? (
              <EmptyState
                title={tr("previewview.preparingBrowser")}
                description={tr("previewview.checkingWhetherControlledChromium")}
                mark={<span className="browser-spinner browser-spinner-large" />}
              />
            ) : cap.available ? (
              <EmptyState
                title={tr("previewview.internalBrowser")}
                description={tr("previewview.enterAnHttpSAddressAbove")}
                mark={<Icon.globe />}
              />
            ) : (
              <EmptyState
                title={tr("previewview.browserUnavailable")}
                description={cap.reason || tr("previewview.controlledChromiumIsNotAvailable")}
                mark={<Icon.shield />}
              />
            )}
          </div>

          {inspectorOpen && browserMode && (
            <aside id={inspectorId} className="inspector browser-inspector" aria-label={tr("previewview.browserInspector")}>
              <div className="inspector-tabs" role="tablist" aria-label={tr("previewview.inspectorViews")}>
                {BROWSER_INSPECTOR_TABS.map((item) => (
                  <button
                    key={item}
                    id={inspectorTabId(item)}
                    type="button"
                    role="tab"
                    aria-selected={tab === item}
                    aria-controls={inspectorPanelId}
                    tabIndex={tab === item ? 0 : -1}
                    className={`tab ${tab === item ? "active" : ""}`}
                    onClick={() => setTab(item)}
                    onKeyDown={(event) => {
                      const next = browserInspectorTabFromKey(tab, event.key);
                      if (!next) return;
                      event.preventDefault();
                      setTab(next);
                      requestAnimationFrame(() => document.getElementById(inspectorTabId(next))?.focus());
                    }}
                  >
                    {item === "snapshot" ? tr("previewview.snapshotTab") : item === "console" ? tr("previewview.consoleTab") : tr("previewview.activityTab")}
                  </button>
                ))}
              </div>
              <div
                id={inspectorPanelId}
                className="inspector-body"
                role="tabpanel"
                aria-labelledby={inspectorTabId(tab)}
                tabIndex={0}
              >
                <div className="browser-inspector-summary">
                  <div className="stat-row">
                    <span className="k">{tr("previewview.page")}</span>
                    <span className="browser-stat-value" title={browser.url}>{browser.title || browser.url}</span>
                  </div>
                  <div className="stat-row">
                    <span className="k">{tr("previewview.status")}</span>
                    <span className={`browser-status-badge ${browser.status} ${agentPaused ? "paused" : connection}`}>
                      {connectionLabel[connection]}
                    </span>
                  </div>
                  <div className="stat-row">
                    <span className="k">{tr("previewview.engine")}</span>
                    <span>{browser.engine} · {browser.viewport.width}×{browser.viewport.height}</span>
                  </div>
                </div>

                {tab === "snapshot" && (
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
                        placeholder={tr("previewview.cssSelectorOptional")}
                        aria-label={tr("previewview.cssSelector")}
                      />
                      <button
                        type="button"
                        className="small-btn"
                        disabled={busy}
                        onClick={() => void takeSnapshot(inspectSelector.trim() || undefined)}
                      >
                        {tr("previewview.read")}
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        disabled={busy || !inspectSelector.trim()}
                        onClick={() => void inspect()}
                      >
                        {tr("previewview.inspect")}
                      </button>
                    </div>
                    <pre>{snapshotText || tr("previewview.readThePageForVisibleText")}</pre>
                  </div>
                )}

                {tab === "console" && (
                  <div className="browser-console" role="log" aria-label={tr("previewview.browserConsole")}>
                    {consoleLines.length === 0 && <div className="browser-inspector-empty">{tr("previewview.noConsoleOutputYet")}</div>}
                    {consoleLines.map((line, index) => (
                      <div key={`${line.at}-${index}`} className={`browser-console-line ${line.level}`}>
                        <time>{new Date(line.at).toLocaleTimeString(getLocale())}</time>
                        <span>{line.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {tab === "activity" && (
                  <div className="browser-console" role="log" aria-label={tr("previewview.browserActivity")}>
                    {activity.length === 0 && <div className="browser-inspector-empty">{tr("previewview.noAgentOrBrowserActivityYet")}</div>}
                    {activity.map((entry, index) => (
                      <div key={`${index}-${entry}`} className="browser-console-line">
                        <span>{entry}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>

      {approval && (
        <Dialog
          title={tr("previewview.approveBrowserOrigin")}
          onClose={() => {
            if (operation !== "approve") setApproval(null);
          }}
          className="browser-confirm-dialog"
          initialFocus=".browser-approval-cancel"
          ariaDescribedBy={approvalDescriptionId}
        >
          <div className="dialog-head">
            <span>{tr("previewview.approveBrowserOrigin")}</span>
            <button
              type="button"
              className="close-btn"
              aria-label={tr("previewview.cancelOriginApproval")}
              disabled={operation === "approve"}
              onClick={() => setApproval(null)}
            >
              <Icon.close />
            </button>
          </div>
          <div className="browser-dialog-body">
            <span className="browser-dialog-mark" aria-hidden="true"><Icon.shield /></span>
            <div>
              <strong>{approvalOrigin}</strong>
              <p id={approvalDescriptionId}>
                {tr("previewview.thisOriginIsOutsideTheBrowser")}
              </p>
              <details>
                <summary>{tr("previewview.whyApprovalIsRequired")}</summary>
                <p>{approval.message}</p>
              </details>
              {approvalError && <div className="form-error" role="alert">{approvalError}</div>}
            </div>
          </div>
          <div className="dialog-foot">
            <span className="browser-dialog-note">{tr("previewview.approveOnlyOriginsYouTrust")}</span>
            <span className="header-spacer" />
            <button
              type="button"
              className="browser-approval-cancel"
              disabled={operation === "approve"}
              onClick={() => setApproval(null)}
            >
              {tr("common.cancel")}
            </button>
            <button
              type="button"
              className="primary-btn browser-approve-button"
              disabled={operation === "approve"}
              onClick={() => void approveNavigation()}
            >
              {operation === "approve" ? tr("previewview.approving") : tr("previewview.approveAndOpen")}
            </button>
          </div>
        </Dialog>
      )}

      {closeConfirmOpen && browserMode && (
        <Dialog
          title={tr("previewview.closeBrowserSession")}
          onClose={() => {
            if (operation !== "close") setCloseConfirmOpen(false);
          }}
          className="browser-confirm-dialog"
          initialFocus=".browser-keep-open"
          resolveRestoreFocus={(opener) => opener ?? addressInputRef.current}
        >
          <div className="dialog-head">
            <span>{tr("previewview.closeBrowserSessionQ")}</span>
            <button
              type="button"
              className="close-btn"
              aria-label={tr("previewview.keepBrowserOpen")}
              disabled={operation === "close"}
              onClick={() => setCloseConfirmOpen(false)}
            >
              <Icon.close />
            </button>
          </div>
          <div className="browser-dialog-body">
            <span className="browser-dialog-mark danger" aria-hidden="true"><Icon.close /></span>
            <div>
              <strong>{tr("previewview.browsingDataWillBeCleared")}</strong>
              <p>{tr("previewview.closingDestroysThisBrowserContext")}</p>
            </div>
          </div>
          <div className="dialog-foot">
            <span className="header-spacer" />
            <button
              type="button"
              className="browser-keep-open"
              disabled={operation === "close"}
              onClick={() => setCloseConfirmOpen(false)}
            >
              {tr("previewview.keepOpen")}
            </button>
            <button
              type="button"
              className="browser-close-confirm danger-btn"
              disabled={operation === "close"}
              onClick={() => void closeBrowser()}
            >
              {operation === "close" ? tr("previewview.closing") : tr("previewview.closeBrowser")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
