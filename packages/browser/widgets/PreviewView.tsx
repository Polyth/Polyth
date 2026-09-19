// Shared internal browser: one server-owned page context operated by the user,
// primary agent, and subagents. Frames stream over /ws; Add context attaches
// structured BrowserContext to the composer draft (never sendMessage).
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, errorCodeOf, type BrowserNavigateResponse, type BrowserSessionDto } from "@polyth/session/web-api";
import type { BrowserContextCaptureInput } from "@polyth/contracts";
import type { SurfaceComponentProps } from "@polyth/web-sdk";
import { attachBrowserContext, newAttachmentId } from "../../../apps/web/src/attachments.ts";
import {
  BROWSER_DEVICE_PRESETS,
  clampViewport,
  compactPageIdentity,
  containedImageRect,
  elementHighlightRect,
  mergeScrollDelta,
  namedPresetForViewport,
  normalizedPointInImage,
  normalizedRectInImage,
  pointedFromActionResult,
  pressKeyFromEvent,
  recalledViewportMode,
  rememberViewportMode,
  type BrowserDevicePresetId,
  type BrowserPointedElement,
  type ImageRect,
  type NormRect,
  type ViewportUiMode,
} from "./browserPreview.ts";
import { useStore, workspaceProjectId } from "../../../apps/web/src/store.ts";
import { usePaneVisible } from "../../../apps/web/src/workspace/paneVisibility.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import Sheet from "../../../apps/web/src/components/mobile/Sheet.tsx";
import {
  BackIcon,
  Button,
  ChevronRightIcon,
  CloseIcon,
  Dialog,
  EmptyState,
  ProjectRequiredEmpty,
  ExternalLinkIcon,
  GlobeIcon,
  Icon,
  IconButton,
  Menu,
  MoreIcon,
  Notice,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  ScanIcon,
  Select,
  ShieldIcon,
  tabId,
  tabPanelId,
  Tabs,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";

type ColorScheme = "light" | "dark" | "no-preference";
type BrowserConnection = "idle" | "connecting" | "connected" | "reconnecting";
type ContextMode = "off" | "select";
type DevTab = "device" | "appearance" | "inspect" | "console" | "activity";

interface ApprovalRequest { url: string; message: string }
interface Capability { available: boolean; engine: "chromium" | "fake" | null; reason?: string }

const DEV_TABS: readonly DevTab[] = ["device", "appearance", "inspect", "console", "activity"];
const TOUCH_SCROLL_THRESHOLD = 8;
const SELECT_DRAG_THRESHOLD = 8;
const ADDED_FEEDBACK_MS = 420;
const NARROW_BREAKPOINT = 720;
const PANE_RESIZE_MS = 180;

function isApprovalResponse(response: BrowserNavigateResponse): response is Extract<BrowserNavigateResponse, { approval: unknown }> {
  return "approval" in response;
}

function isEditableElement(element: BrowserPointedElement): boolean {
  if (element.editable === true) return true;
  if (element.editable === false) return false;
  const tag = element.tag.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (element.attributes?.type ?? "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden", "range", "color"].includes(type);
  }
  if (element.attributes?.contenteditable === "true" || element.attributes?.contenteditable === "") return true;
  return element.role === "textbox";
}

export default function PreviewView({
  projectId: scopedProjectId,
  sessionId: scopedSessionId,
}: SurfaceComponentProps) {
  const storeProjectId = useStore(workspaceProjectId);
  const storeSessionId = useStore((s) => s.activeSessionId);
  const projectId = scopedProjectId === undefined ? storeProjectId : scopedProjectId;
  const activeSessionId = scopedSessionId === undefined ? storeSessionId : scopedSessionId;
  const visible = usePaneVisible();

  const [urlInput, setUrlInput] = useState("");
  const [devTab, setDevTab] = useState<DevTab>("device");
  const [devOpen, setDevOpen] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [cap, setCap] = useState<Capability | null>(null);
  const [browser, setBrowser] = useState<BrowserSessionDto | null>(null);
  const [frame, setFrame] = useState<{ revision: number; src: string } | null>(null);
  const [agentPaused, setAgentPaused] = useState(false);
  const [agentController, setAgentController] = useState<"user" | "agent" | null>(null);
  const [currentAgentAction, setCurrentAgentAction] = useState<string | null>(null);
  const [activity, setActivity] = useState<string[]>([]);
  const [consoleLines, setConsoleLines] = useState<Array<{ at: number; level: string; message: string }>>([]);
  const [snapshotText, setSnapshotText] = useState("");
  const [inspectSelector, setInspectSelector] = useState("");
  const [customWidth, setCustomWidth] = useState("");
  const [customHeight, setCustomHeight] = useState("");
  const [imageRect, setImageRect] = useState<ImageRect>({ left: 0, top: 0, width: 0, height: 0 });
  const [captureBusy, setCaptureBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [connection, setConnection] = useState<BrowserConnection>("idle");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [approvalError, setApprovalError] = useState("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [contextMode, setContextMode] = useState<ContextMode>("off");
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [viewportMode, setViewportMode] = useState<ViewportUiMode>("responsive");
  const [highlight, setHighlight] = useState<NormRect | null>(null);
  const [highlightAdded, setHighlightAdded] = useState(false);
  const [remoteFocus, setRemoteFocus] = useState(false);
  const [addressEditing, setAddressEditing] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const revisionRef = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const focusProxyRef = useRef<HTMLInputElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const annotationDragStart = useRef<{ x: number; y: number } | null>(null);
  const touchScroll = useRef<{ id: number; x: number; y: number; scrolled: boolean; lastX: number; lastY: number } | null>(null);
  const followPaneRef = useRef(true);
  const remoteFocusRef = useRef(false);
  const composingRef = useRef(false);
  const scrollPending = useRef<{ x: number; y: number } | null>(null);
  const scrollRaf = useRef(0);
  const scrollInFlight = useRef(false);
  const resizeInFlight = useRef(false);
  const resizeQueued = useRef<{ width: number; height: number } | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentTargetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentTargetHighlightRef = useRef(false);
  const generationRef = useRef(0);
  const focusUrlRef = useRef("");
  const contextModeRef = useRef<ContextMode>("off");
  const highlightAddedRef = useRef(false);
  const paneResizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef(browser?.viewport);
  const visibleRef = useRef(visible);
  const approvalDescriptionId = useId();
  const frameStatusId = useId();
  const drawerId = useId();
  const drawerTabId = (item: DevTab) => tabId(drawerId, item);

  const [focusEpoch, setFocusEpoch] = useState(0);
  const agentActing = agentController === "agent";
  const youHaveControl = agentPaused && !agentActing;
  viewportRef.current = browser?.viewport;
  visibleRef.current = visible;
  followPaneRef.current = viewportMode === "responsive";
  contextModeRef.current = contextMode;
  highlightAddedRef.current = highlightAdded;
  useEffect(() => { remoteFocusRef.current = remoteFocus; }, [remoteFocus]);

  const clearAgentTargetHighlight = () => {
    agentTargetHighlightRef.current = false;
    if (agentTargetTimer.current) {
      clearTimeout(agentTargetTimer.current);
      agentTargetTimer.current = null;
    }
    setHighlight(null);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setNarrow(root.clientWidth > 0 && root.clientWidth <= NARROW_BREAKPOINT);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

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
    setBrowser((current) => {
      if (!current) return current;
      if (projectId && current.projectId !== projectId) return null;
      if (activeSessionId && current.sessionId !== activeSessionId) return null;
      return current;
    });
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
        // A session-linked browser belongs to exactly one canonical session.
        // While the permission gate is resolving, the blank browser may not
        // exist yet; keep polling for that exact link instead of showing a
        // different browser from the same project.
        const next = activeSessionId ? matching ?? null : sessions.at(-1) ?? null;
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
        ws.send(JSON.stringify({
          type: "browser/subscribe",
          browserSessionId: browser.id,
          afterRevision: revisionRef.current,
          visible: visibleRef.current,
        }));
      };
      ws.onmessage = (m) => {
        if (closed) return;
        try {
          const msg = JSON.parse(String(m.data)) as {
            type: string; revision?: number; mime?: string; data?: string;
            event?: {
              kind: string; message?: string; url?: string; actor?: string;
              targetRect?: { x: number; y: number; width: number; height: number };
            };
          };
          if (msg.type === "browser/frame" && msg.data) {
            const revision = msg.revision ?? 0;
            if (revision !== revisionRef.current
              && contextModeRef.current !== "select"
              && !highlightAddedRef.current
              && !agentTargetHighlightRef.current) {
              setHighlight(null);
            }
            revisionRef.current = revision;
            setFrame({ revision, src: `data:${msg.mime};base64,${msg.data}` });
          } else if (msg.type === "browser/event" && msg.event) {
            const e = msg.event;
            setActivity((prev) => [...prev.slice(-99), `${e.kind}${e.actor ? ` (${e.actor})` : ""}${e.url ? ` ${e.url}` : ""}${e.message ? ` — ${e.message}` : ""}`]);
            if ((e.kind === "action" || e.kind === "target") && e.actor === "agent") {
              if (e.kind === "action") {
                const labels: Record<string, string> = {
                  click: tr("previewview.actionClick"), type: tr("previewview.typingIntoThePage"),
                  scroll: tr("previewview.actionScroll"), navigate: tr("previewview.actionNavigate"),
                  wait: tr("previewview.actionWait"), back: tr("common.back"),
                  forward: tr("previewview.forward"), reload: tr("previewview.reload"), inspect: tr("previewview.inspect"),
                };
                setCurrentAgentAction(labels[e.message?.replace(/^target /, "") ?? ""] ?? tr("previewview.agentControlling"));
              }
              if (e.targetRect && browser.viewport.width > 0 && browser.viewport.height > 0) {
                agentTargetHighlightRef.current = true;
                setHighlight(elementHighlightRect(e.targetRect, browser.viewport));
                if (agentTargetTimer.current) clearTimeout(agentTargetTimer.current);
                agentTargetTimer.current = setTimeout(() => {
                  agentTargetHighlightRef.current = false;
                  agentTargetTimer.current = null;
                  setHighlight(null);
                }, 2400);
              }
            }
            if (e.kind === "controller") {
              setAgentController(e.actor === "agent" || e.actor === "user" ? e.actor : null);
            }
            if (e.kind === "agent-paused") setAgentPaused(true);
            if (e.kind === "agent-resumed") setAgentPaused(false);
            if (e.kind === "crash") {
              setFrame(null);
              setBrowser((current) => current ? { ...current, status: "failed" } : current);
              setAgentController(null);
              setCurrentAgentAction(null);
            }
            if (e.kind === "navigation" || e.kind === "closed") {
              setRemoteFocus(false);
              clearAgentTargetHighlight();
              setCurrentAgentAction(null);
              focusUrlRef.current = "";
              void api.browserGet(browser.id).then(setBrowser).catch(() => setBrowser(null));
            }
          }
        } catch { /* ignore */ }
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
      clearAgentTargetHighlight();
      wsRef.current?.close();
      setConnection("idle");
    };
  }, [browser?.id]);

  // Kept-alive workbench surfaces stay connected while hidden so canonical
  // browser state remains current, but hidden panes must stop counting as a
  // visible viewer for screencast pacing.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !browser) return;
    ws.send(JSON.stringify({
      type: "browser/subscribe",
      browserSessionId: browser.id,
      afterRevision: revisionRef.current,
      visible,
    }));
  }, [visible, browser?.id]);

  useEffect(() => {
    if (browser?.viewport) {
      setCustomWidth(String(browser.viewport.width));
      setCustomHeight(String(browser.viewport.height));
    }
  }, [browser?.viewport.width, browser?.viewport.height]);

  useEffect(() => {
    const image = imgRef.current;
    if (!image || !browser) return;
    const update = () => {
      setImageRect(containedImageRect(image.clientWidth,
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

  useEffect(() => {
    if (!browser || !devOpen || devTab !== "console" || !visible) return;
    const load = () => void api.browserConsole(browser.id).then(setConsoleLines);
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [browser?.id, devOpen, devTab, visible]);

  useEffect(() => {
    if (!remoteFocus) return;
    const proxy = focusProxyRef.current;
    if (!proxy || proxy.readOnly) return;
    if (document.activeElement !== proxy) proxy.focus();
  }, [remoteFocus, focusEpoch]);

  useEffect(() => {
    if (!browser?.id) return;
    generationRef.current += 1;
    const stored = recalledViewportMode(browser.id);
    const fromDto = browser.viewportMode;
    followPaneRef.current = (fromDto ?? stored) === "responsive";
    setViewportMode(fromDto ?? stored);
    setAgentPaused(browser.agentPaused === true);
    setAgentController(browser.controller ?? null);
    setCurrentAgentAction(null);
    setControlBusy(false);
    return () => {
      generationRef.current += 1;
      if (addedTimer.current) clearTimeout(addedTimer.current);
      if (agentTargetTimer.current) clearTimeout(agentTargetTimer.current);
      agentTargetTimer.current = null;
      agentTargetHighlightRef.current = false;
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
    };
  }, [browser?.id]);

  const clearContextUi = () => {
    setContextMode("off");
    setContextPickerOpen(false);
    clearAgentTargetHighlight();
    setHighlight(null);
    setHighlightAdded(false);
    annotationDragStart.current = null;
    if (addedTimer.current) {
      clearTimeout(addedTimer.current);
      addedTimer.current = null;
    }
  };

  const leaveInteractionModes = () => {
    clearContextUi();
    setRemoteFocus(false);
  };

  const openBrowser = async () => {
    if (!projectId || !cap?.available || operation) return;
    setOperation("open");
    setError("");
    try {
      if (browser?.status === "failed") await api.browserClose(browser.id);
      const dto = await api.browserCreate({
        projectId,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
        viewport: clampViewport(
          stageRef.current?.clientWidth || rootRef.current?.clientWidth || 1280,
          stageRef.current?.clientHeight || Math.max(240, (rootRef.current?.clientHeight ?? 800) - 48),
        ),
      });
      rememberViewportMode(dto.id, "responsive");
      setViewportMode("responsive");
      revisionRef.current = 0;
      setBrowser(dto);
      let opened = dto;
      const requestedUrl = urlInput.trim();
      if (requestedUrl) {
        const navigation = await api.browserNavigate(dto.id, requestedUrl, "user");
        if (isApprovalResponse(navigation)) {
          setApproval({ url: requestedUrl, message: navigation.approval.message });
          setApprovalError("");
        } else {
          opened = navigation;
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
    clearAgentTargetHighlight();
    setError("");
    try {
      await api.browserClose(browser.id);
      setBrowser(null);
      setFrame(null);
      leaveInteractionModes();
      setDevOpen(false);
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
    clearAgentTargetHighlight();
    setError("");
    try {
      const navigation = await api.browserNavigate(browser.id, requestedUrl, "user");
      if (isApprovalResponse(navigation)) {
        setApproval({ url: requestedUrl, message: navigation.approval.message });
        setApprovalError("");
        return;
      }
      setBrowser(navigation);
    } catch (e) {
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
      await api.browserApprove(approval.url, browser.id);
      const navigation = await api.browserNavigate(browser.id, approval.url, "user");
      if (isApprovalResponse(navigation)) {
        setApprovalError(navigation.approval.message);
        return;
      }
      setBrowser(navigation);
      setApproval(null);
    } catch (cause) {
      setApprovalError(friendlyError(tr("previewview.couldnTApproveThisOrigin"), cause));
    } finally {
      setOperation(null);
    }
  };

  const act = async (action: Parameters<typeof api.browserAction>[1]) => {
    if (!browser || operation) return { ok: false as const, result: null };
    clearAgentTargetHighlight();
    setOperation(action.kind);
    setError("");
    try {
      const { session, result } = await api.browserAction(browser.id, action, "user");
      setBrowser(session);
      return { ok: true as const, result: result ?? null };
    } catch (e) {
      setError(friendlyError(tr("previewview.browserActionFailed"), e));
      return { ok: false as const, result: null };
    } finally {
      setOperation(null);
    }
  };

  /** Frame interactions (scroll/click/type/press) must not lock the chrome. */
  const actLive = async (action: Parameters<typeof api.browserAction>[1]) => {
    if (!browser) return { ok: false as const, result: null, session: null };
    clearAgentTargetHighlight();
    const gen = generationRef.current;
    try {
      const { session, result } = await api.browserAction(browser.id, action, "user");
      if (gen !== generationRef.current) return { ok: false as const, result: null, session: null };
      setBrowser(session);
      return { ok: true as const, result: result ?? null, session };
    } catch (e) {
      if (gen !== generationRef.current) return { ok: false as const, result: null, session: null };
      if (errorCodeOf(e) !== "stale-frame") {
        setError(friendlyError(tr("previewview.browserActionFailed"), e));
      }
      return { ok: false as const, result: null, session: null };
    }
  };

  const flushScroll = () => {
    scrollRaf.current = 0;
    if (scrollInFlight.current) return;
    const pending = scrollPending.current;
    scrollPending.current = null;
    if (!pending || (pending.x === 0 && pending.y === 0) || !browser || !frame) return;
    scrollInFlight.current = true;
    const gen = generationRef.current;
    void actLive({
      kind: "scroll",
      x: pending.x,
      y: pending.y,
      target: {
        point: { x: Math.round(browser.viewport.width / 2), y: Math.round(browser.viewport.height / 2) },
        frameRevision: frame.revision,
      },
    }).finally(() => {
      if (gen !== generationRef.current) {
        scrollInFlight.current = false;
        return;
      }
      scrollInFlight.current = false;
      if (scrollPending.current) flushScroll();
    });
  };

  const queueScroll = (dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    scrollPending.current = mergeScrollDelta(scrollPending.current, dx, dy);
    if (scrollInFlight.current || scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(flushScroll);
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
      setDevTab("inspect");
      setDevOpen(true);
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
      setDevTab("inspect");
      setDevOpen(true);
    }
  };

  const framePointFromClient = (clientX: number, clientY: number) => {
    if (!browser || !imgRef.current) return null;
    const bounds = imgRef.current.getBoundingClientRect();
    const visibleImage = containedImageRect(bounds.width,
      bounds.height,
      browser.viewport.width,
      browser.viewport.height,
    );
    const point = normalizedPointInImage(clientX - bounds.left, clientY - bounds.top, visibleImage);
    if (!point) return null;
    return {
      x: Math.round(point.x * browser.viewport.width),
      y: Math.round(point.y * browser.viewport.height),
      local: { x: clientX - bounds.left, y: clientY - bounds.top },
    };
  };

  const annotationPoint = (clientX: number, clientY: number) => {
    const image = imgRef.current;
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  };

  const attachContext = async (
    input: BrowserContextCaptureInput,
    opts?: { retryPage?: boolean; ignoreCodes?: readonly string[] },
  ): Promise<{ ok: true } | { ok: false; code?: string }> => {
    if (!browser) return { ok: false };
    const gen = generationRef.current;
    setCaptureBusy(true);
    setError("");
    try {
      const { context } = await api.browserCaptureContext(browser.id, input);
      if (gen !== generationRef.current) return { ok: false };
      const attached = attachBrowserContext(activeSessionId, context);
      if (!attached.ok) throw new Error(attached.reason);
      if (context.element?.bounds) {
        setHighlight(elementHighlightRect(context.element.bounds, browser.viewport));
      } else if (context.region?.normalized) {
        const n = context.region.normalized;
        setHighlight({ x: n.x, y: n.y, width: n.width, height: n.height });
      }
      setHighlightAdded(true);
      setContextMode("off");
      if (addedTimer.current) clearTimeout(addedTimer.current);
      addedTimer.current = setTimeout(() => {
        if (gen !== generationRef.current) return;
        setHighlightAdded(false);
        setHighlight(null);
        annotationDragStart.current = null;
        addedTimer.current = null;
      }, ADDED_FEEDBACK_MS);
      return { ok: true };
    } catch (e) {
      if (gen !== generationRef.current) return { ok: false };
      if (errorCodeOf(e) === "stale-frame" && opts?.retryPage && input.type === "page") {
        try {
          const latest = await api.browserGet(browser.id);
          if (gen !== generationRef.current || !latest) return { ok: false };
          setBrowser(latest);
          const retried = await api.browserCaptureContext(browser.id, {
            ...input,
            expectedRevision: latest.revision,
          });
          if (gen !== generationRef.current) return { ok: false };
          const attached = attachBrowserContext(activeSessionId, retried.context);
          if (!attached.ok) throw new Error(attached.reason);
          setHighlightAdded(true);
          setContextMode("off");
          if (addedTimer.current) clearTimeout(addedTimer.current);
          addedTimer.current = setTimeout(() => {
            if (gen !== generationRef.current) return;
            setHighlightAdded(false);
            setHighlight(null);
            addedTimer.current = null;
          }, ADDED_FEEDBACK_MS);
          return { ok: true };
        } catch (retryErr) {
          if (gen !== generationRef.current) return { ok: false };
          if (errorCodeOf(retryErr) === "stale-frame") setError(tr("previewview.pageChanged"));
          else setError(friendlyError(tr("previewview.couldnTSendTheBrowserCapture"), retryErr));
          return { ok: false, code: errorCodeOf(retryErr) ?? undefined };
        }
      }
      const code = errorCodeOf(e) ?? undefined;
      if (code && opts?.ignoreCodes?.includes(code)) return { ok: false, code };
      if (code === "stale-frame") setError(tr("previewview.pageChanged"));
      else setError(friendlyError(tr("previewview.couldnTSendTheBrowserCapture"), e));
      return { ok: false, code };
    } finally {
      if (gen === generationRef.current) setCaptureBusy(false);
    }
  };

  const applyRemoteFocus = (
    element: BrowserPointedElement | null | undefined,
    viewport?: { width: number; height: number },
    url?: string,
  ) => {
    const vp = viewport ?? browser?.viewport;
    if (element?.tag && element.rect && vp && isEditableElement(element)) {
      setHighlight(elementHighlightRect(element.rect, vp));
      setRemoteFocus(true);
      focusUrlRef.current = url ?? browser?.url ?? "";
      const proxy = focusProxyRef.current;
      if (proxy) {
        proxy.readOnly = false;
        proxy.inputMode = "text";
        if (document.activeElement !== proxy) proxy.focus();
      }
      setFocusEpoch((n) => n + 1);
      return;
    }
    setRemoteFocus(false);
    focusUrlRef.current = "";
    setHighlight(null);
    const proxy = focusProxyRef.current;
    if (proxy) {
      proxy.readOnly = true;
      proxy.inputMode = "none";
      proxy.blur();
    }
  };

  const finishSelectFromPage = async (startLocal: { x: number; y: number }, endLocal: { x: number; y: number }) => {
    if (!browser || !frame) return;
    const drag = Math.hypot(endLocal.x - startLocal.x, endLocal.y - startLocal.y);
    if (drag < SELECT_DRAG_THRESHOLD) {
      const mapped = framePointFromClient(
        (imgRef.current?.getBoundingClientRect().left ?? 0) + endLocal.x,
        (imgRef.current?.getBoundingClientRect().top ?? 0) + endLocal.y,
      );
      if (!mapped) return;
      await attachContext({
        type: "element",
        id: newAttachmentId(),
        expectedRevision: frame.revision,
        point: { x: mapped.x, y: mapped.y },
      });
      return;
    }
    const startPt = framePointFromClient(
      (imgRef.current?.getBoundingClientRect().left ?? 0) + startLocal.x,
      (imgRef.current?.getBoundingClientRect().top ?? 0) + startLocal.y,
    );
    const endPt = framePointFromClient(
      (imgRef.current?.getBoundingClientRect().left ?? 0) + endLocal.x,
      (imgRef.current?.getBoundingClientRect().top ?? 0) + endLocal.y,
    );
    const rect = normalizedRectInImage(startLocal, endLocal, imageRect);
    if (rect) setHighlight(rect);
    if (!startPt || !endPt) return;
    const text = await attachContext({
      type: "text",
      id: newAttachmentId(),
      expectedRevision: frame.revision,
      start: { x: startPt.x, y: startPt.y },
      end: { x: endPt.x, y: endPt.y },
    }, { ignoreCodes: ["empty-text-range"] });
    if (text.ok || text.code !== "empty-text-range") return;
    if (!rect) return;
    await attachContext({
      type: "area",
      id: newAttachmentId(),
      expectedRevision: frame.revision,
      region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  };

  const handleFrameActivate = async (clientX: number, clientY: number) => {
    if (!browser || !frame || operation || captureBusy) return;
    const mapped = framePointFromClient(clientX, clientY);
    if (!mapped) return;
    if (contextMode === "select") return;
    const clicked = await actLive({
      kind: "click",
      target: { point: { x: mapped.x, y: mapped.y }, frameRevision: frame.revision },
    });
    if (!clicked.ok || !clicked.session) return;
    if (focusUrlRef.current && clicked.session.url !== focusUrlRef.current) {
      applyRemoteFocus(null);
      return;
    }
    applyRemoteFocus(pointedFromActionResult(clicked.result), clicked.session.viewport, clicked.session.url);
  };

  const onFramePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (contextMode === "select") {
      const point = annotationPoint(event.clientX, event.clientY);
      if (!point || !normalizedPointInImage(point.x, point.y, imageRect)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      annotationDragStart.current = point;
      setHighlight(null);
      setHighlightAdded(false);
      return;
    }
    if (event.pointerType === "mouse") return;
    if (!remoteFocusRef.current) {
      const proxy = focusProxyRef.current;
      if (proxy) {
        proxy.readOnly = true;
        proxy.inputMode = "none";
        proxy.focus();
      }
    }
    touchScroll.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      scrolled: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onFramePointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (contextMode === "select") {
      if (!annotationDragStart.current) return;
      const point = annotationPoint(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const rect = normalizedRectInImage(annotationDragStart.current, point, imageRect);
      if (rect) setHighlight(rect);
      return;
    }
    const touch = touchScroll.current;
    if (!touch || touch.id !== event.pointerId || !browser || !frame) return;
    const dx = event.clientX - touch.lastX;
    const dy = event.clientY - touch.lastY;
    const total = Math.hypot(event.clientX - touch.x, event.clientY - touch.y);
    if (!touch.scrolled && total < TOUCH_SCROLL_THRESHOLD) return;
    if (!touch.scrolled) applyRemoteFocus(null);
    touch.scrolled = true;
    touch.lastX = event.clientX;
    touch.lastY = event.clientY;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    queueScroll(-dx, -dy);
  };

  const onFramePointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (contextMode === "select") {
      const start = annotationDragStart.current;
      const point = annotationPoint(event.clientX, event.clientY);
      annotationDragStart.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (start && point) void finishSelectFromPage(start, point);
      return;
    }
    const touch = touchScroll.current;
    if (touch && touch.id === event.pointerId) {
      const wasScroll = touch.scrolled;
      touchScroll.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!wasScroll) {
        const proxy = focusProxyRef.current;
        if (proxy) {
          // Unlock inside the same user gesture so WebKit can present the
          // keyboard. Non-editable taps blur again once click metadata returns.
          proxy.readOnly = false;
          proxy.inputMode = "text";
          proxy.focus();
        }
        void handleFrameActivate(event.clientX, event.clientY);
      } else {
        applyRemoteFocus(null);
      }
      return;
    }
  };

  const onFrameClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (event.detail === 0) return;
    if (contextMode === "select") return;
    if (touchScroll.current) return;
    void handleFrameActivate(event.clientX, event.clientY);
  };

  const onFrameWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!browser || !frame || contextMode !== "off") return;
    event.preventDefault();
    queueScroll(event.deltaX, event.deltaY);
  };

  const setAgentControl = async (paused: boolean) => {
    if (!browser || controlBusy) return;
    clearAgentTargetHighlight();
    const browserId = browser.id;
    const generation = generationRef.current;
    setControlBusy(true);
    setError("");
    try {
      await api.browserPauseAgent(browserId, paused);
      if (generationRef.current !== generation) return;
      setAgentPaused(paused);
    } catch (cause) {
      setError(friendlyError(
        paused ? tr("previewview.couldnTPauseAgentControl") : tr("previewview.couldnTResumeAgentControl"),
        cause,
      ));
    } finally {
      if (generationRef.current === generation) setControlBusy(false);
    }
  };

  const commitViewportMode = (mode: ViewportUiMode) => {
    setViewportMode(mode);
    followPaneRef.current = mode === "responsive";
    if (browser?.id) rememberViewportMode(browser.id, mode);
  };

  const applyCustomViewport = () => {
    if (!browser) return;
    const viewport = clampViewport(
      Number.parseInt(customWidth, 10) || browser.viewport.width,
      Number.parseInt(customHeight, 10) || browser.viewport.height,
    );
    setCustomWidth(String(viewport.width));
    setCustomHeight(String(viewport.height));
    commitViewportMode("custom");
    void actLive({ kind: "resize", viewport, mode: "custom" });
  };

  const flushResize = () => {
    if (resizeInFlight.current) return;
    const queued = resizeQueued.current;
    resizeQueued.current = null;
    if (!queued || !browser || !followPaneRef.current) return;
    resizeInFlight.current = true;
    const gen = generationRef.current;
    void actLive({ kind: "resize", viewport: queued, mode: "responsive" }).finally(() => {
      if (gen !== generationRef.current) {
        resizeInFlight.current = false;
        return;
      }
      resizeInFlight.current = false;
      if (resizeQueued.current) flushResize();
    });
  };

  const applyPaneViewport = (width: number, height: number) => {
    if (!browser || !followPaneRef.current) return;
    const viewport = clampViewport(width, height);
    const current = viewportRef.current;
    if (current && viewport.width === current.width && viewport.height === current.height) return;
    resizeQueued.current = viewport;
    if (!resizeInFlight.current) flushResize();
  };

  useEffect(() => {
    const stage = stageRef.current;
    const live = !!browser && browser.status !== "closed";
    if (!stage || !live) return;
    const schedule = () => {
      if (!followPaneRef.current) return;
      if (paneResizeTimer.current) clearTimeout(paneResizeTimer.current);
      paneResizeTimer.current = setTimeout(() => {
        applyPaneViewport(stage.clientWidth, stage.clientHeight);
      }, PANE_RESIZE_MS);
    };
    schedule();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", schedule);
      return () => window.removeEventListener("resize", schedule);
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    return () => {
      observer.disconnect();
      if (paneResizeTimer.current) clearTimeout(paneResizeTimer.current);
    };
  }, [browser?.id, browser?.status]);

  const onProxyKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!remoteFocus) return;
    if (composingRef.current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setRemoteFocus(false);
      setHighlight(null);
      return;
    }
    const special = pressKeyFromEvent(event);
    if (special) {
      event.preventDefault();
      void actLive({ kind: "press", key: special }).then((out) => {
        if (!out.ok || !out.session) return;
        if (focusUrlRef.current && out.session.url !== focusUrlRef.current) {
          applyRemoteFocus(null);
          return;
        }
        applyRemoteFocus(pointedFromActionResult(out.result), out.session.viewport, out.session.url);
      });
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      void actLive({ kind: "type", target: { selector: ":focus" }, text: event.key });
    }
  };

  const onProxyInput = (event: React.FormEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    const value = event.currentTarget.value;
    if (!value) return;
    event.currentTarget.value = "";
    void actLive({ kind: "type", target: { selector: ":focus" }, text: value });
  };

  const onProxyCompositionStart = () => {
    composingRef.current = true;
  };

  const onProxyCompositionEnd = (event: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    const value = event.data || event.currentTarget.value;
    event.currentTarget.value = "";
    if (value) void actLive({ kind: "type", target: { selector: ":focus" }, text: value });
  };

  if (!projectId) {
    return (
      <ProjectRequiredEmpty
        title={tr("previewview.noProjectSelected")}
        description={tr("previewview.openAProjectToUseTheInternalBrowser")}
      />
    );
  }

  const browserMode = !!browser && browser.status !== "closed";
  const busy = operation !== null || captureBusy;
  const namedPreset = browserMode
    ? namedPresetForViewport(browser.viewport.width, browser.viewport.height)
    : null;
  const viewportSelectValue: BrowserDevicePresetId | "custom" =
    viewportMode === "responsive"
      ? "responsive"
      : namedPreset && viewportMode === "preset"
        ? namedPreset
        : viewportMode === "custom" || !namedPreset
          ? "custom"
          : namedPreset;
  const showCustomViewport = viewportSelectValue === "custom";
  const connectionLabel: Record<BrowserConnection, string> = {
    idle: tr("previewview.disconnected"),
    connecting: tr("previewview.connecting"),
    connected: agentPaused ? tr("previewview.agentPaused") : tr("previewview.live"),
    reconnecting: tr("previewview.reconnecting"),
  };
  let approvalOrigin = approval?.url ?? "";
  if (approval) {
    try {
      const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(approval.url) ? approval.url : `http://${approval.url}`;
      approvalOrigin = new URL(raw).origin;
    } catch { /* keep raw */ }
  }

  const compactAddress = browserMode && narrow && !addressEditing
    ? compactPageIdentity(urlInput || browser.url)
    : urlInput;

  const startSelectFromPage = () => {
    setContextPickerOpen(false);
    setHighlight(null);
    setHighlightAdded(false);
    setRemoteFocus(false);
    setContextMode("select");
  };

  const captureWholePage = () => {
    setContextPickerOpen(false);
    setRemoteFocus(false);
    if (!frame) return;
    void attachContext(
      { type: "page", id: newAttachmentId(), expectedRevision: frame.revision },
      { retryPage: true },
    );
  };

  const contextKindEntries = [
    { id: "select", label: tr("previewview.selectFromPage"), onSelect: startSelectFromPage },
    { id: "page", label: tr("previewview.wholePage"), onSelect: captureWholePage },
  ];

  const moreEntries = [
    ...(narrow && browserMode
      ? [{
        id: "forward",
        label: tr("previewview.forward"),
        icon: ChevronRightIcon,
        disabled: busy,
        onSelect: () => void act({ kind: "forward" }),
      }]
      : []),
    {
      id: "devtools",
      label: tr("previewview.developerTools"),
      onSelect: () => setDevOpen(true),
    },
    ...(browserMode && browser.url !== "about:blank"
      ? [{
        id: "external",
        label: tr("previewview.openPageInANewTab"),
        icon: ExternalLinkIcon,
        onSelect: () => { window.open(browser.url, "_blank", "noopener,noreferrer"); },
      }]
      : []),
    "separator" as const,
    {
      id: "close",
      label: tr("previewview.closeBrowser"),
      danger: true,
      icon: CloseIcon,
      disabled: !browserMode || busy,
      onSelect: () => setCloseConfirmOpen(true),
    },
  ];

  const renderDevTools = (inSheet: boolean) => (
    <div className={inSheet ? "browser-dev-sheet" : "browser-dev-drawer"} id={inSheet ? undefined : drawerId}>
      {!inSheet && (
        <div className="browser-dev-header">
          <strong>{tr("previewview.developerTools")}</strong>
          <IconButton
            icon={CloseIcon}
            size="sm"
            variant="ghost"
            label={tr("common.close")}
            onClick={() => setDevOpen(false)}
          />
        </div>
      )}
      <Tabs
        idBase={drawerId}
        className="inspector-tabs ui-scroll-tabs"
        size="sm"
        label={tr("previewview.inspectorViews")}
        value={devTab}
        tabs={DEV_TABS.map((item) => ({
          id: item,
          label: item === "device" ? tr("previewview.deviceTab")
            : item === "appearance" ? tr("previewview.appearanceTab")
              : item === "inspect" ? tr("previewview.inspect")
                : item === "console" ? tr("previewview.consoleTab")
                  : tr("previewview.activityTab"),
        }))}
        onChange={(value) => setDevTab(value as DevTab)}
      />
      <div
        id={tabPanelId(drawerId, devTab)}
        className="inspector-body"
        role="tabpanel"
        aria-labelledby={drawerTabId(devTab)}
        tabIndex={0}
      >
        {devTab === "device" && browserMode && (
          <div className="browser-dev-section">
            <Select
              className="browser-device"
              ariaLabel={tr("previewview.browserDevicePreset")}
              label={(() => {
                if (viewportSelectValue === "custom") return tr("previewview.customViewport");
                const preset = BROWSER_DEVICE_PRESETS.find((p) => p.id === viewportSelectValue);
                return preset ? tr(preset.labelKey) : tr("previewview.browserDevicePreset");
              })()}
              disabled={busy}
              value={viewportSelectValue}
              options={[
                ...BROWSER_DEVICE_PRESETS.map((preset) => ({
                  value: preset.id,
                  label: preset.id === "responsive"
                    ? tr(preset.labelKey)
                    : `${tr(preset.labelKey)} · ${preset.width}×${preset.height}`,
                })),
                { value: "custom", label: tr("previewview.customViewport") },
              ]}
              onChange={(value) => {
                if (!browser) return;
                if (value === "custom") {
                  commitViewportMode("custom");
                  void actLive({ kind: "resize", viewport: browser.viewport, mode: "custom" });
                  return;
                }
                const preset = BROWSER_DEVICE_PRESETS.find(
                  (candidate) => candidate.id === value as BrowserDevicePresetId,
                );
                if (!preset) return;
                if (preset.id === "responsive") {
                  commitViewportMode("responsive");
                  const stage = stageRef.current;
                  const viewport = stage
                    ? clampViewport(stage.clientWidth, stage.clientHeight)
                    : browser.viewport;
                  void actLive({ kind: "resize", viewport, mode: "responsive" });
                  return;
                }
                commitViewportMode("preset");
                void actLive({
                  kind: "resize",
                  viewport: { width: preset.width, height: preset.height },
                  mode: "preset",
                });
              }}
            />
            {showCustomViewport && (
              <span className="browser-size-fields" aria-label={tr("previewview.viewportSize")}>
                <TextInput
                  className="browser-size-input"
                  uiSize="sm"
                  type="number"
                  min={320}
                  max={3840}
                  value={customWidth}
                  disabled={busy}
                  aria-label={tr("previewview.viewportWidth")}
                  onChange={(event) => setCustomWidth(event.target.value)}
                  onBlur={() => applyCustomViewport()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyCustomViewport();
                    }
                  }}
                />
                <span className="browser-size-sep" aria-hidden="true">×</span>
                <TextInput
                  className="browser-size-input"
                  uiSize="sm"
                  type="number"
                  min={240}
                  max={2160}
                  value={customHeight}
                  disabled={busy}
                  aria-label={tr("previewview.viewportHeight")}
                  onChange={(event) => setCustomHeight(event.target.value)}
                  onBlur={() => applyCustomViewport()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyCustomViewport();
                    }
                  }}
                />
              </span>
            )}
          </div>
        )}

        {devTab === "appearance" && browserMode && (
          <div className="browser-dev-section">
            <Select
              className="browser-scheme"
              ariaLabel={tr("previewview.emulatedColorScheme")}
              label={browser.colorScheme === "dark" ? tr("previewview.darkTheme") : tr("previewview.lightTheme")}
              disabled={busy}
              value={browser.colorScheme === "dark" ? "dark" : "light"}
              options={[
                { value: "light", label: tr("previewview.lightTheme") },
                { value: "dark", label: tr("previewview.darkTheme") },
              ]}
              onChange={(value) => void act({ kind: "color-scheme", colorScheme: value as ColorScheme })}
            />
          </div>
        )}

        {devTab === "inspect" && browserMode && (
          <div className="browser-snapshot">
            <div className="browser-inspect-controls">
              <TextInput
                uiSize="sm"
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
              <Button size="sm" disabled={busy} onClick={() => void takeSnapshot(inspectSelector.trim() || undefined)}>
                {tr("previewview.read")}
              </Button>
              <Button size="sm" disabled={busy || !inspectSelector.trim()} onClick={() => void inspect()}>
                {tr("previewview.inspect")}
              </Button>
            </div>
            <pre>{snapshotText || tr("previewview.readThePageForVisibleText")}</pre>
          </div>
        )}

        {devTab === "console" && (
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

        {devTab === "activity" && (
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
    </div>
  );

  return (
    <>
      <div
        ref={rootRef}
        className={`preview-view${narrow ? " is-narrow" : ""}${remoteFocus ? " is-remote-focus" : ""}`}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          if (contextMode !== "off") {
            event.preventDefault();
            event.stopPropagation();
            clearContextUi();
            return;
          }
          if (remoteFocus) {
            event.preventDefault();
            event.stopPropagation();
            setRemoteFocus(false);
            setHighlight(null);
            return;
          }
          if (highlight) {
            event.preventDefault();
            event.stopPropagation();
            setHighlight(null);
            return;
          }
          if (devOpen) {
            event.preventDefault();
            event.stopPropagation();
            setDevOpen(false);
            requestAnimationFrame(() => moreButtonRef.current?.focus());
          }
        }}
      >
        <div className="browser-chrome browser-toolbar" aria-label={tr("previewview.browserControls")}>
          <div className="browser-navigation-row">
            {browserMode && (
              <span className="browser-history" role="group" aria-label={tr("previewview.pageHistory")}>
                <IconButton
                  icon={BackIcon}
                  size="sm"
                  variant="ghost"
                  title={tr("common.back")}
                  label={tr("common.back")}
                  disabled={busy}
                  onClick={() => void act({ kind: "back" })}
                />
                {!narrow && (
                  <IconButton
                    icon={ChevronRightIcon}
                    size="sm"
                    variant="ghost"
                    title={tr("previewview.forward")}
                    label={tr("previewview.forward")}
                    disabled={busy}
                    onClick={() => void act({ kind: "forward" })}
                  />
                )}
                <IconButton
                  icon={RefreshIcon}
                  size="sm"
                  variant="ghost"
                  title={tr("previewview.reload")}
                  label={tr("previewview.reload")}
                  disabled={busy}
                  onClick={() => void act({ kind: "reload" })}
                />
              </span>
            )}
            <form
              className="url-pill browser-address"
              aria-label={tr("previewview.browserAddress")}
              onSubmit={(event) => {
                event.preventDefault();
                setAddressEditing(false);
                if (browserMode) void navigate(urlInput);
                else void openBrowser();
              }}
            >
              {!narrow && (
                <span className="browser-address-icon" aria-hidden="true"><Icon icon={GlobeIcon} size="sm" /></span>
              )}
              <TextInput
                ref={addressInputRef}
                value={compactAddress}
                onChange={(event) => {
                  setAddressEditing(true);
                  setUrlInput(event.target.value);
                }}
                onFocus={() => setAddressEditing(true)}
                onBlur={() => setAddressEditing(false)}
                placeholder="https://example.com"
                aria-label={tr("previewview.address")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                disabled={!browserMode && cap?.available !== true}
              />
              {!narrow && (
                <IconButton
                  type="submit"
                  icon={ChevronRightIcon}
                  size="sm"
                  variant="ghost"
                  className="browser-address-submit"
                  label={browserMode ? tr("previewview.navigate") : tr("previewview.openBrowser")}
                  title={browserMode ? tr("previewview.navigate") : tr("previewview.openBrowser")}
                  disabled={busy || (!browserMode && cap?.available !== true)}
                  busy={operation === "navigate" || operation === "open"}
                />
              )}
            </form>

            {browserMode && (
              <Menu
                label={tr("previewview.addContext")}
                entries={contextKindEntries}
                open={contextPickerOpen}
                onOpenChange={setContextPickerOpen}
              >
                {(trigger) => (
                  narrow ? (
                    <IconButton
                      {...trigger}
                      icon={PlusIcon}
                      size="sm"
                      variant="ghost"
                      className="browser-add-context"
                      disabled={busy || !frame}
                      aria-pressed={contextMode !== "off"}
                      label={tr("previewview.addContext")}
                      title={tr("previewview.addContext")}
                    />
                  ) : (
                    <Button
                      {...trigger}
                      size="sm"
                      variant="ghost"
                      iconStart={PlusIcon}
                      className="browser-add-context"
                      disabled={busy || !frame}
                      aria-pressed={contextMode !== "off"}
                      title={tr("previewview.addContext")}
                    >
                      {tr("previewview.addContext")}
                    </Button>
                  )
                )}
              </Menu>
            )}

            <Menu label={tr("previewview.more")} entries={moreEntries} align="end">
              {(trigger) => (
                <IconButton
                  ref={(node) => {
                    moreButtonRef.current = node;
                    const r = trigger.ref;
                    if (typeof r === "function") r(node);
                    else if (r && typeof r === "object") (r as { current: HTMLButtonElement | null }).current = node;
                  }}
                  onClick={trigger.onClick}
                  aria-haspopup={trigger["aria-haspopup"]}
                  aria-expanded={trigger["aria-expanded"]}
                  icon={MoreIcon}
                  size="sm"
                  variant="ghost"
                  label={tr("previewview.more")}
                  title={tr("previewview.more")}
                  className={devOpen ? "is-active" : undefined}
                />
              )}
            </Menu>
          </div>
        </div>

        {error && (
          <Notice
            tone="error"
            className="browser-alert"
            role="alert"
            actions={<IconButton icon={CloseIcon} size="sm" variant="ghost" label={tr("previewview.dismissBrowserError")} onClick={() => setError("")} />}
          >{error}</Notice>
        )}

        <div className="preview-body">
          <div className="preview-stage browser-viewport" aria-busy={operation === "open" || operation === "navigate"}>
            {browserMode ? (
              frame ? (
                <div className="browser-frame-wrap">
                  <div
                    ref={stageRef}
                    className={`browser-frame-stage${contextMode === "select" ? " is-selecting" : ""}`}
                    onWheel={onFrameWheel}
                  >
                    <div className="browser-frame-shot">
                      <img
                        ref={imgRef}
                        src={frame.src}
                        alt={tr("previewview.interactiveBrowserFrameValue", { title: browser.title || browser.url || tr("previewview.untitledPage") })}
                        className={`browser-frame-img${contextMode === "select" ? " selecting" : ""}`}
                        aria-describedby={frameStatusId}
                        role="button"
                        tabIndex={0}
                        draggable={false}
                        onClick={onFrameClick}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          void handleFrameActivate(
                            (imgRef.current?.getBoundingClientRect().left ?? 0) + imageRect.left + imageRect.width / 2,
                            (imgRef.current?.getBoundingClientRect().top ?? 0) + imageRect.top + imageRect.height / 2,
                          );
                        }}
                        onPointerDown={onFramePointerDown}
                        onPointerMove={onFramePointerMove}
                        onPointerUp={onFramePointerUp}
                        onPointerCancel={() => {
                          annotationDragStart.current = null;
                          touchScroll.current = null;
                        }}
                        onLoad={(event) => setImageRect(containedImageRect(event.currentTarget.clientWidth,
                          event.currentTarget.clientHeight,
                          browser.viewport.width,
                          browser.viewport.height,
                        ))}
                      />
                      <div className="browser-annotation-layer" aria-hidden="true">
                        {highlight && highlight.width > 0 && highlight.height > 0 && (
                          <div
                            className={`browser-annotation-box${remoteFocus ? " is-focus" : ""}${highlightAdded ? " is-added" : ""}`}
                            style={{
                              left: imageRect.left + highlight.x * imageRect.width,
                              top: imageRect.top + highlight.y * imageRect.height,
                              width: highlight.width * imageRect.width,
                              height: highlight.height * imageRect.height,
                            }}
                          />
                        )}
                      </div>
                    </div>
                    {contextMode === "select" && (
                      <div className="browser-frame-mode" role="status">
                        {captureBusy
                          ? <><span className="browser-spinner" aria-hidden="true" /> {tr("previewview.addContext")}</>
                          : <><Icon icon={ScanIcon} size="sm" /> {tr("previewview.selectOnThePage")}</>}
                        <kbd>Esc</kbd>
                      </div>
                    )}
                    {highlightAdded && (
                      <div className="browser-frame-mode is-added" role="status">
                        {tr("previewview.addedToMessage")}
                      </div>
                    )}
                    {browser && (
                      <div className="browser-frame-hud">
                        {connection === "reconnecting" && (
                          <span className="browser-frame-hud-status">
                            <span className="browser-live-dot reconnecting" aria-hidden="true" />
                            {tr("previewview.reconnecting")}
                          </span>
                        )}
                        {agentActing && (
                          <>
                            <span className="browser-frame-hud-status browser-current-action" title={currentAgentAction ?? undefined}>
                              {currentAgentAction ?? tr("previewview.agentControlling")}
                            </span>
                            {!agentPaused && (
                              <Button size="sm" variant="ghost" iconStart={PauseIcon} disabled={controlBusy} onClick={() => void setAgentControl(true)}>
                                {tr("previewview.takeControl")}
                              </Button>
                            )}
                          </>
                        )}
                        {!agentActing && !agentPaused && (
                          <Button size="sm" variant="ghost" iconStart={PauseIcon} disabled={controlBusy} onClick={() => void setAgentControl(true)}>
                            {tr("previewview.takeControl")}
                          </Button>
                        )}
                        {youHaveControl && (
                          <>
                            <span className="browser-frame-hud-status">{tr("previewview.youHaveControl")}</span>
                            <Button size="sm" variant="ghost" iconStart={PlayIcon} disabled={controlBusy} onClick={() => void setAgentControl(false)}>
                              {tr("previewview.resumeAgent")}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                    <span id={frameStatusId} className="sr-only">
                      {connectionLabel[connection]}
                      {remoteFocus ? ` · ${tr("previewview.typingIntoThePage")}` : ""}
                    </span>
                  </div>
                </div>
              ) : browser.status === "failed" ? (
                <EmptyState
                  title={tr("previewview.browserStopped")}
                  description={tr("previewview.theControlledBrowserCouldNot")}
                  actionLabel={tr("previewview.openBrowser")}
                  onAction={() => void openBrowser()}
                  mark={<Icon icon={ShieldIcon} size="lg" />}
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
                mark={<Icon icon={GlobeIcon} size="lg" />}
              />
            ) : (
              <EmptyState
                title={tr("previewview.browserUnavailable")}
                description={cap.reason || tr("previewview.controlledChromiumIsNotAvailable")}
                mark={<Icon icon={ShieldIcon} size="lg" />}
              />
            )}

            <input
              ref={focusProxyRef}
              className="browser-focus-proxy"
              type="text"
              inputMode={remoteFocus ? "text" : "none"}
              readOnly={!remoteFocus}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              tabIndex={-1}
              onKeyDown={onProxyKeyDown}
              onInput={onProxyInput}
              onCompositionStart={onProxyCompositionStart}
              onCompositionEnd={onProxyCompositionEnd}
              aria-label={tr("previewview.typeIntoTheFocusedPageField")}
            />
          </div>

          {devOpen && browserMode && !narrow && renderDevTools(false)}
        </div>
      </div>

      {devOpen && browserMode && narrow && (
        <Sheet title={tr("previewview.developerTools")} onClose={() => setDevOpen(false)} size="tall">
          {renderDevTools(true)}
        </Sheet>
      )}

      {approval && (
        <Dialog
          title={tr("previewview.approveBrowserOrigin")}
          onClose={() => { if (operation !== "approve") setApproval(null); }}
          className="browser-confirm-dialog"
          initialFocus=".browser-approval-cancel"
          ariaDescribedBy={approvalDescriptionId}
          footer={
            <>
              <span className="browser-dialog-note">{tr("previewview.approveOnlyOriginsYouTrust")}</span>
              <span className="header-spacer" />
              <Button className="browser-approval-cancel" disabled={operation === "approve"} onClick={() => setApproval(null)}>
                {tr("common.cancel")}
              </Button>
              <Button variant="primary" className="browser-approve-button" busy={operation === "approve"} onClick={() => void approveNavigation()}>
                {operation === "approve" ? tr("previewview.approving") : tr("previewview.approveAndOpen")}
              </Button>
            </>
          }
        >
          <div className="browser-dialog-body">
            <span className="browser-dialog-mark" aria-hidden="true"><Icon icon={ShieldIcon} size="md" /></span>
            <div>
              <strong>{approvalOrigin}</strong>
              <p id={approvalDescriptionId}>{tr("previewview.thisOriginIsOutsideTheBrowser")}</p>
              <details>
                <summary>{tr("previewview.whyApprovalIsRequired")}</summary>
                <p>{approval.message}</p>
              </details>
              {approvalError && <div className="form-error" role="alert">{approvalError}</div>}
            </div>
          </div>
        </Dialog>
      )}

      {closeConfirmOpen && browserMode && (
        <Dialog
          title={tr("previewview.closeBrowserSession")}
          onClose={() => { if (operation !== "close") setCloseConfirmOpen(false); }}
          className="browser-confirm-dialog"
          initialFocus=".browser-keep-open"
          resolveRestoreFocus={(opener) => opener ?? addressInputRef.current}
          footer={
            <>
              <span className="header-spacer" />
              <Button className="browser-keep-open" disabled={operation === "close"} onClick={() => setCloseConfirmOpen(false)}>
                {tr("previewview.keepOpen")}
              </Button>
              <Button variant="danger" className="browser-close-confirm" busy={operation === "close"} onClick={() => void closeBrowser()}>
                {operation === "close" ? tr("previewview.closing") : tr("previewview.closeBrowser")}
              </Button>
            </>
          }
        >
          <div className="browser-dialog-body">
            <span className="browser-dialog-mark danger" aria-hidden="true"><Icon icon={CloseIcon} size="md" /></span>
            <div>
              <strong>{tr("previewview.browsingDataWillBeCleared")}</strong>
              <p>{tr("previewview.closingDestroysThisBrowserContext")}</p>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
