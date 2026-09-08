import { useCallback, useEffect, useRef } from "react";
import type { ChatTabEventDto, ChatTabStateDto } from "@polyth/contracts";
import type { ApiTransport } from "@polyth/web-sdk";
import { ApiError } from "@polyth/web-sdk";
import {
  acceptsFrames,
  buildSubscribeMessage,
  initialScreencastState,
  transitionScreencast,
  type ScreencastSubscriptionState,
} from "./screencastSubscription.ts";

export interface FramePayload {
  mime: string;
  data: string;
  width: number;
  height: number;
  revision: number;
  popupId?: string;
}

export function useScreencastSubscription(opts: {
  transport: ApiTransport;
  projectId: string;
  tabId: string | null;
  visible: boolean;
  quality: number;
  onFrame(frame: FramePayload): void;
  onEvent?(event: ChatTabEventDto): void;
  onState?(state: ChatTabStateDto): void;
  onActivateError?(code: string): void;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<ScreencastSubscriptionState>(initialScreencastState());
  const mountedRef = useRef(true);
  const gestureRef = useRef(0);
  const onFrameRef = useRef(opts.onFrame);
  const onEventRef = useRef(opts.onEvent);
  const onStateRef = useRef(opts.onState);
  const onActivateErrorRef = useRef(opts.onActivateError);
  onFrameRef.current = opts.onFrame;
  onEventRef.current = opts.onEvent;
  onStateRef.current = opts.onState;
  onActivateErrorRef.current = opts.onActivateError;

  const noteGesture = useCallback(() => {
    gestureRef.current = Date.now();
  }, []);

  const sendSubscribe = useCallback((tabId: string, visible: boolean, afterRevision: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(buildSubscribeMessage(tabId, visible, afterRevision, opts.quality)));
  }, [opts.quality]);

  const closeSocket = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const loadState = useCallback(async (tabId: string) => {
    if (!opts.projectId) return;
    try {
      const state = await opts.transport.get<ChatTabStateDto>(
        `/api/chat-workspace/tabs/${encodeURIComponent(tabId)}/state?projectId=${encodeURIComponent(opts.projectId)}`,
      );
      onStateRef.current?.(state);
    } catch {
      // tab may not be live yet
    }
  }, [opts.projectId, opts.transport]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stateRef.current = transitionScreencast(stateRef.current, { type: "unmount" });
      closeSocket();
    };
  }, [closeSocket]);

  useEffect(() => {
    stateRef.current = transitionScreencast(stateRef.current, { type: "select-tab", tabId: opts.tabId });
    if (!opts.tabId) {
      closeSocket();
      return;
    }
    void loadState(opts.tabId);
    closeSocket();
    let cancelled = false;
    void (async () => {
      if (!opts.projectId) return;
      try {
        await opts.transport.post(
          `/api/chat-workspace/tabs/${encodeURIComponent(opts.tabId!)}/activate?projectId=${encodeURIComponent(opts.projectId)}`,
          {},
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === "profile-locked") {
          onActivateErrorRef.current?.("profile-locked");
        }
      }
      if (cancelled || !mountedRef.current) return;
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (!mountedRef.current) return;
        sendSubscribe(opts.tabId!, opts.visible, stateRef.current.revision);
      };
      ws.onmessage = (ev) => {
        if (!mountedRef.current) return;
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          data?: string;
          mime?: string;
          width?: number;
          height?: number;
          revision?: number;
          popupId?: string;
          kind?: string;
          tabId?: string;
          origin?: string;
          reason?: string;
          message?: string;
          url?: string;
          text?: string;
        };
        if (msg.type === "chat-workspace/frame" && msg.data) {
          const revision = Number(msg.revision ?? 0);
          if (!msg.popupId) {
            stateRef.current = transitionScreencast(stateRef.current, { type: "frame", revision });
          }
          if (!acceptsFrames(stateRef.current) && !msg.popupId) return;
          onFrameRef.current({
            mime: msg.mime ?? "image/jpeg",
            data: msg.data,
            width: Number(msg.width ?? 0),
            height: Number(msg.height ?? 0),
            revision,
            ...(msg.popupId ? { popupId: msg.popupId } : {}),
          });
          return;
        }
        if (msg.type === "chat-workspace/event" && msg.kind && msg.tabId) {
          const event: ChatTabEventDto = {
            tabId: msg.tabId,
            kind: msg.kind,
            ...(msg.origin ? { origin: msg.origin } : {}),
            ...(msg.reason ? { reason: msg.reason } : {}),
            ...(msg.message ? { message: msg.message } : {}),
            ...(msg.url ? { url: msg.url } : {}),
            ...(msg.popupId ? { popupId: msg.popupId } : {}),
            ...(msg.text ? { text: msg.text } : {}),
          };
          onEventRef.current?.(event);
          if (msg.kind === "clipboard-written" && msg.text && Date.now() - gestureRef.current < 3000) {
            void navigator.clipboard.writeText(msg.text);
          }
        }
      };
    })();
    return () => {
      cancelled = true;
      closeSocket();
    };
  }, [opts.tabId, opts.projectId, closeSocket, sendSubscribe, loadState]);

  useEffect(() => {
    stateRef.current = transitionScreencast(stateRef.current, { type: "set-visible", visible: opts.visible });
    if (opts.tabId) sendSubscribe(opts.tabId, opts.visible, stateRef.current.revision);
  }, [opts.visible, opts.tabId, sendSubscribe]);

  return { noteGesture, gestureRef };
}
