import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiTransport } from "@polyth/web-sdk";
import type { ChatTabEventDto, ChatTabStateDto } from "@polyth/contracts";
import { Button } from "../../../apps/web/src/components/ui/index.ts";
import Sheet from "../../../apps/web/src/components/mobile/Sheet.tsx";
import { arrayBufferToBase64 } from "./lib/binary.ts";
import { ChatWorkspacePopupOverlay } from "./lib/ChatWorkspacePopupOverlay.tsx";
import {
  clampViewport,
  containedImageRect,
  modifiersFromEvent,
  normalizedPointInImage,
  pagePointFromNormalized,
  pressKeyFromEvent,
  VIEWPORT_RESIZE_DEBOUNCE_MS,
} from "./lib/viewportGeometry.ts";
import { useScreencastSubscription } from "./lib/useScreencast.ts";
import {
  clearProfileLocked,
  dismissApproval,
  dismissDownloadBlocked,
  dismissFileChooser,
  emptyOverlayModel,
  overlayFromState,
  reduceTabOverlay,
  type TabOverlayModel,
} from "./lib/tabOverlayState.ts";

export type ChatWorkspaceSelectionAction = "add-to-agent" | "ask-agent" | "new-agent-chat";

export function ChatWorkspaceViewport(props: {
  transport: ApiTransport;
  projectId: string;
  tabId: string | null;
  visible: boolean;
  quality: number;
  providerName?: string;
  loading?: boolean;
  profileLocked?: boolean;
  onProfileLockedChange?(locked: boolean): void;
  onOpenProfileChooser?(): void;
  onHandoffSelection?(text: string, action: ChatWorkspaceSelectionAction): void | Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewportCssRef = useRef({ width: 1280, height: 800 });
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeInFlightRef = useRef(false);
  const resizeQueuedRef = useRef<{ width: number; height: number } | null>(null);
  const [imageRect, setImageRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [overlay, setOverlay] = useState<TabOverlayModel>(emptyOverlayModel());
  const [popupFrame, setPopupFrame] = useState<{ popupId: string; mime: string; data: string; width: number; height: number } | null>(null);
  const [selection, setSelection] = useState<{ text: string; left: number; top: number } | null>(null);
  const activePopup = overlay.popups.at(-1) ?? null;

  const drawFrame = useCallback((mime: string, data: string, width: number, height: number, popupId?: string) => {
    if (popupId) {
      setPopupFrame({ popupId, mime, data, width, height });
      return;
    }
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0);
      const viewport = viewportCssRef.current;
      setImageRect(containedImageRect(wrap.clientWidth, wrap.clientHeight, viewport.width, viewport.height));
    };
    img.src = `data:${mime};base64,${data}`;
  }, []);

  const { noteGesture } = useScreencastSubscription({
    transport: props.transport,
    projectId: props.projectId,
    tabId: props.tabId,
    visible: props.visible,
    quality: props.quality,
    onFrame: (frame) => drawFrame(frame.mime, frame.data, frame.width, frame.height, frame.popupId),
    onEvent: (event) => setOverlay((prev) => reduceTabOverlay(prev, event)),
    onState: (state) => setOverlay(overlayFromState(state)),
    onActivateError: (code) => {
      if (code === "profile-locked") {
        setOverlay((prev) => ({ ...prev, profileLocked: true }));
        props.onProfileLockedChange?.(true);
      }
    },
  });

  const tabAction = async (action: string, body?: Record<string, unknown>) => {
    if (!props.tabId) return;
    await props.transport.post(
      `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/${action}?projectId=${encodeURIComponent(props.projectId)}`,
      body ?? {},
    );
  };

  const sendInput = async (body: Record<string, unknown>) => {
    if (!props.tabId) return;
    await props.transport.post(
      `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/input?projectId=${encodeURIComponent(props.projectId)}`,
      body,
    );
  };

  const pointForEvent = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const bounds = wrap.getBoundingClientRect();
    const norm = normalizedPointInImage(clientX - bounds.left, clientY - bounds.top, imageRect);
    if (!norm) return null;
    return pagePointFromNormalized(norm, viewportCssRef.current);
  };

  const flushResize = useCallback(async () => {
    if (!props.tabId || resizeInFlightRef.current) return;
    const queued = resizeQueuedRef.current;
    resizeQueuedRef.current = null;
    if (!queued) return;
    resizeInFlightRef.current = true;
    try {
      await props.transport.post(
        `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/resize?projectId=${encodeURIComponent(props.projectId)}`,
        {
          width: queued.width,
          height: queued.height,
          deviceScaleFactor: window.devicePixelRatio,
        },
      );
      viewportCssRef.current = queued;
      const wrap = wrapRef.current;
      if (wrap) {
        setImageRect(containedImageRect(wrap.clientWidth, wrap.clientHeight, queued.width, queued.height));
      }
    } finally {
      resizeInFlightRef.current = false;
      if (resizeQueuedRef.current) void flushResize();
    }
  }, [props.projectId, props.tabId, props.transport]);

  const scheduleResize = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !props.tabId) return;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      const viewport = clampViewport(wrap.clientWidth, wrap.clientHeight);
      const current = viewportCssRef.current;
      if (viewport.width === current.width && viewport.height === current.height) {
        setImageRect(containedImageRect(wrap.clientWidth, wrap.clientHeight, viewport.width, viewport.height));
        return;
      }
      viewportCssRef.current = viewport;
      setImageRect(containedImageRect(wrap.clientWidth, wrap.clientHeight, viewport.width, viewport.height));
      resizeQueuedRef.current = viewport;
      if (!resizeInFlightRef.current) void flushResize();
    }, VIEWPORT_RESIZE_DEBOUNCE_MS);
  }, [flushResize, props.tabId]);

  const onPointer = async (kind: "move" | "down" | "up" | "click" | "dblclick", e: React.PointerEvent) => {
    noteGesture();
    canvasRef.current?.focus();
    const pt = pointForEvent(e.clientX, e.clientY);
    if (!pt) return;
    await sendInput({
      inputType: "mouse",
      kind,
      x: pt.x,
      y: pt.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
      modifiers: modifiersFromEvent(e),
    });
  };

  const captureSelection = async (clientX: number, clientY: number) => {
    if (!props.tabId || !props.onHandoffSelection) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    try {
      const res = await props.transport.post<{ text: string }>(
        `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/clipboard/copy?projectId=${encodeURIComponent(props.projectId)}`,
        {},
      );
      const text = res.text.trim();
      if (!text) {
        setSelection(null);
        return;
      }
      const bounds = wrap.getBoundingClientRect();
      const toolbarWidth = 310;
      setSelection({
        text,
        left: Math.max(8, Math.min(clientX - bounds.left, Math.max(8, bounds.width - toolbarWidth - 8))),
        top: Math.max(8, Math.min(clientY - bounds.top + 10, Math.max(8, bounds.height - 44))),
      });
    } catch {
      setSelection(null);
    }
  };

  const runSelectionAction = async (action: ChatWorkspaceSelectionAction) => {
    if (!selection || !props.onHandoffSelection) return;
    const text = selection.text;
    setSelection(null);
    await props.onHandoffSelection(text, action);
  };

  const onWheel = async (e: React.WheelEvent) => {
    noteGesture();
    setSelection(null);
    const pt = pointForEvent(e.clientX, e.clientY);
    if (!pt) return;
    e.preventDefault();
    await sendInput({ inputType: "wheel", dx: e.deltaX, dy: e.deltaY, x: pt.x, y: pt.y });
  };

  const isPrintableKey = (event: React.KeyboardEvent) =>
    event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

  const relayKey = async (kind: "down" | "up" | "press", event: React.KeyboardEvent) => {
    const key = pressKeyFromEvent(event);
    if (!key) return;
    event.preventDefault();
    await sendInput({ inputType: "key", kind, key, modifiers: modifiersFromEvent(event) });
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    noteGesture();
    setSelection(null);
    const isCopy = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c";
    const isPaste = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v";
    if (isCopy && props.tabId) {
      const res = await props.transport.post<{ text: string }>(
        `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/clipboard/copy?projectId=${encodeURIComponent(props.projectId)}`,
        {},
      );
      if (res.text) await navigator.clipboard.writeText(res.text);
      await relayKey("down", e);
      await relayKey("up", e);
      return;
    }
    if (isPaste && props.tabId) {
      const text = await navigator.clipboard.readText();
      await props.transport.post(
        `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/clipboard/paste?projectId=${encodeURIComponent(props.projectId)}`,
        { text },
      );
      await relayKey("down", e);
      await relayKey("up", e);
      return;
    }
    if (isPrintableKey(e)) {
      e.preventDefault();
      await sendInput({ inputType: "key", kind: "press", key: e.key, modifiers: modifiersFromEvent(e) });
      return;
    }
    await relayKey("down", e);
  };

  const onKeyUp = async (e: React.KeyboardEvent) => {
    noteGesture();
    if (isPrintableKey(e)) return;
    await relayKey("up", e);
  };

  const uploadFile = async (file: File) => {
    if (!props.tabId) return;
    const data = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(data);
    await props.transport.post(
      `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/upload?projectId=${encodeURIComponent(props.projectId)}`,
      { name: file.name, mimeType: file.type || "application/octet-stream", data: base64 },
    );
    setOverlay((prev) => dismissFileChooser(prev));
  };

  useEffect(() => {
    const onResize = () => scheduleResize();
    window.addEventListener("resize", onResize);
    const wrap = wrapRef.current;
    const observer = wrap ? new ResizeObserver(onResize) : null;
    if (wrap && props.tabId) {
      observer?.observe(wrap);
      const viewport = clampViewport(wrap.clientWidth, wrap.clientHeight);
      viewportCssRef.current = viewport;
      setImageRect(containedImageRect(wrap.clientWidth, wrap.clientHeight, viewport.width, viewport.height));
      resizeQueuedRef.current = viewport;
      void flushResize();
      scheduleResize();
    }
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [props.tabId, flushResize, scheduleResize]);

  useEffect(() => {
    setSelection(null);
  }, [props.tabId]);

  useEffect(() => {
    if (props.profileLocked) {
      setOverlay((prev) => (prev.profileLocked ? prev : { ...prev, profileLocked: true }));
    }
  }, [props.profileLocked]);

  const retryAfterProfileLock = async () => {
    if (!props.tabId) return;
    setOverlay((prev) => clearProfileLocked(prev));
    props.onProfileLockedChange?.(false);
    try {
      await props.transport.post(
        `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/activate?projectId=${encodeURIComponent(props.projectId)}`,
        {},
      );
    } catch {
      setOverlay((prev) => ({ ...prev, profileLocked: true }));
      props.onProfileLockedChange?.(true);
    }
  };

  const provider = props.providerName ?? "chat";

  return (
    <div ref={wrapRef} className="chat-workspace-viewport">
      {props.loading ? <div className="chat-workspace-loading-bar" aria-hidden /> : null}
      <canvas
        ref={canvasRef}
        className="chat-workspace-canvas"
        tabIndex={0}
        onPointerMove={(e) => void onPointer("move", e)}
        onPointerDown={(e) => { setSelection(null); void onPointer("down", e); }}
        onPointerUp={(e) => {
          const clientX = e.clientX;
          const clientY = e.clientY;
          void onPointer("up", e).then(() => captureSelection(clientX, clientY));
        }}
        onClick={(e) => { canvasRef.current?.focus(); void onPointer("click", e as unknown as React.PointerEvent); }}
        onDoubleClick={(e) => void onPointer("dblclick", e as unknown as React.PointerEvent)}
        onWheel={(e) => void onWheel(e)}
        onKeyDown={(e) => void onKeyDown(e)}
        onKeyUp={(e) => void onKeyUp(e)}
      />
      {selection ? (
        <div
          role="toolbar"
          aria-label="Use selected external chat text in Polyth"
          style={{
            position: "absolute",
            left: selection.left,
            top: selection.top,
            zIndex: 12,
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: 3,
            borderRadius: 10,
            background: "var(--surface-raised, rgba(24,24,27,.94))",
            boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            backdropFilter: "blur(16px)",
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button size="sm" variant="ghost" onClick={() => void runSelectionAction("add-to-agent")}>Add to agent</Button>
          <Button size="sm" variant="ghost" onClick={() => void runSelectionAction("ask-agent")}>Ask agent</Button>
          <Button size="sm" variant="ghost" onClick={() => void runSelectionAction("new-agent-chat")}>New chat</Button>
        </div>
      ) : null}
      {overlay.approval ? (
        <div className="chat-workspace-overlay chat-workspace-overlay-approval">
          <p>This chat wants to open: {overlay.approval.origin}</p>
          <p>Reason: {overlay.approval.reason}</p>
          <div className="chat-workspace-overlay-actions">
            <Button size="sm" onClick={() => void tabAction("approve-origin", {
              origin: overlay.approval!.origin,
              mode: "once",
              retryUrl: overlay.approval!.url,
            }).then(() => setOverlay((p) => dismissApproval(p)))}>Allow once</Button>
            <Button size="sm" onClick={() => void tabAction("approve-origin", {
              origin: overlay.approval!.origin,
              mode: "always",
              retryUrl: overlay.approval!.url,
            }).then(() => setOverlay((p) => dismissApproval(p)))}>Always allow for this profile</Button>
            <Button size="sm" variant="ghost" onClick={() => setOverlay((p) => dismissApproval(p))}>Block</Button>
            <Button size="sm" variant="ghost" onClick={() => overlay.approval?.url && window.open(overlay.approval.url, "_blank")}>Open externally</Button>
          </div>
        </div>
      ) : null}
      {activePopup && props.tabId ? (
        <ChatWorkspacePopupOverlay
          transport={props.transport}
          projectId={props.projectId}
          tabId={props.tabId}
          popup={activePopup}
          frame={popupFrame?.popupId === activePopup.popupId ? popupFrame : null}
          onClose={() => {
            setPopupFrame(null);
            setOverlay((prev) => ({
              ...prev,
              popups: prev.popups.filter((p) => p.popupId !== activePopup.popupId),
            }));
          }}
        />
      ) : null}
      {overlay.fileChooser ? (
        <Sheet title="Attach file" onClose={() => setOverlay((p) => dismissFileChooser(p))}>
          <input ref={fileInputRef} type="file" hidden onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadFile(file);
          }}
          />
          <Button onClick={() => fileInputRef.current?.click()}>Choose from this device</Button>
          <Button variant="ghost" onClick={() => setOverlay((p) => dismissFileChooser(p))}>Cancel</Button>
        </Sheet>
      ) : null}
      {overlay.downloadBlocked ? (
        <div className="chat-workspace-overlay chat-workspace-overlay-notice">
          <p>Downloads are not available yet in Chat Workspace</p>
          <Button size="sm" variant="ghost" onClick={() => setOverlay((p) => dismissDownloadBlocked(p))}>Dismiss</Button>
        </div>
      ) : null}
      {overlay.crashed ? (
        <ViewportFailure
          title="Chat tab stopped"
          body={`${provider} could not be restored.`}
          actions={[
            { label: "Reload", onClick: () => void tabAction("reload").then(() => setOverlay((p) => ({ ...p, crashed: false }))) },
            { label: "Open home", onClick: () => void tabAction("navigate", { url: "about:blank" }) },
            { label: "Close", onClick: () => props.tabId && void tabAction("stop") },
          ]}
        />
      ) : null}
      {overlay.unreachable ? (
        <ViewportFailure
          title={`${overlay.unreachable.domain} could not be reached`}
          body=""
          actions={[{ label: "Retry", onClick: () => void tabAction("reload") }]}
        />
      ) : null}
      {overlay.profileLocked ? (
        <ViewportFailure
          title="This profile is already active on another Polyth runtime."
          body=""
          actions={[
            { label: "Retry", onClick: () => void retryAfterProfileLock() },
            { label: "Use another profile", onClick: () => {
              setOverlay((prev) => clearProfileLocked(prev));
              props.onProfileLockedChange?.(false);
              props.onOpenProfileChooser?.();
            } },
          ]}
        />
      ) : null}
      {overlay.profileRestarted ? (
        <div className="chat-workspace-overlay chat-workspace-overlay-notice">
          <p>Chat profile restarted</p>
          <p>Your login data was preserved.</p>
          <p>Tabs are being restored.</p>
        </div>
      ) : null}
    </div>
  );
}

export function ViewportFailure(props: {
  title: string;
  body: string;
  actions: Array<{ label: string; onClick(): void }>;
}) {
  return (
    <div className="chat-workspace-failure">
      <h3>{props.title}</h3>
      {props.body ? <p>{props.body}</p> : null}
      <div className="chat-workspace-failure-actions">
        {props.actions.map((a) => <Button key={a.label} size="sm" onClick={a.onClick}>{a.label}</Button>)}
      </div>
    </div>
  );
}
