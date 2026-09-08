import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiTransport } from "@polyth/web-sdk";
import {
  containedImageRect,
  modifiersFromEvent,
  normalizedPointInImage,
  pagePointFromNormalized,
  pressKeyFromEvent,
} from "./viewportGeometry.ts";

export function ChatWorkspacePopupOverlay(props: {
  transport: ApiTransport;
  projectId: string;
  tabId: string;
  popup: { popupId: string; url?: string };
  frame?: { mime: string; data: string; width: number; height: number } | null;
  onClose(): void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportCssRef = useRef({ width: 960, height: 720 });
  const [imageRect, setImageRect] = useState({ left: 0, top: 0, width: 0, height: 0 });

  const drawFrame = useCallback((mime: string, data: string) => {
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

  useEffect(() => {
    if (props.frame) {
      viewportCssRef.current = { width: props.frame.width, height: props.frame.height };
      drawFrame(props.frame.mime, props.frame.data);
    }
  }, [props.frame, drawFrame]);

  const popupAction = async (body: Record<string, unknown>) => {
    await props.transport.post(
      `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/popup/${encodeURIComponent(props.popup.popupId)}/input?projectId=${encodeURIComponent(props.projectId)}`,
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

  const onPointer = async (kind: "move" | "down" | "up" | "click" | "dblclick", e: React.PointerEvent) => {
    canvasRef.current?.focus();
    const pt = pointForEvent(e.clientX, e.clientY);
    if (!pt) return;
    await popupAction({
      inputType: "mouse",
      kind,
      x: pt.x,
      y: pt.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
      modifiers: modifiersFromEvent(e),
    });
  };

  const onWheel = async (e: React.WheelEvent) => {
    const pt = pointForEvent(e.clientX, e.clientY);
    if (!pt) return;
    e.preventDefault();
    await popupAction({ inputType: "wheel", dx: e.deltaX, dy: e.deltaY, x: pt.x, y: pt.y });
  };

  const relayKey = async (kind: "down" | "up" | "press", event: React.KeyboardEvent) => {
    const key = pressKeyFromEvent(event);
    if (!key) return;
    event.preventDefault();
    await popupAction({ inputType: "key", kind, key, modifiers: modifiersFromEvent(event) });
    if (key === "Escape") props.onClose();
  };

  const closePopup = async () => {
    await props.transport.post(
      `/api/chat-workspace/tabs/${encodeURIComponent(props.tabId)}/popup/${encodeURIComponent(props.popup.popupId)}/close?projectId=${encodeURIComponent(props.projectId)}`,
      {},
    );
    props.onClose();
  };

  return (
    <div className="chat-workspace-popup-overlay">
      <div className="chat-workspace-popup-chrome">
        <span className="chat-workspace-popup-title">{props.popup.url ?? "Popup"}</span>
        <button type="button" className="chat-workspace-popup-close" onClick={() => void closePopup()} aria-label="Close popup">×</button>
      </div>
      <div ref={wrapRef} className="chat-workspace-popup-viewport">
        <canvas
          ref={canvasRef}
          className="chat-workspace-popup-canvas"
          tabIndex={0}
          onPointerMove={(e) => void onPointer("move", e)}
          onPointerDown={(e) => void onPointer("down", e)}
          onPointerUp={(e) => void onPointer("up", e)}
          onClick={(e) => void onPointer("click", e as unknown as React.PointerEvent)}
          onDoubleClick={(e) => void onPointer("dblclick", e as unknown as React.PointerEvent)}
          onWheel={(e) => void onWheel(e)}
          onKeyDown={(e) => void relayKey("down", e)}
          onKeyUp={(e) => void relayKey("up", e)}
        />
      </div>
    </div>
  );
}
