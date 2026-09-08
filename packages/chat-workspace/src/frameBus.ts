import type {
  ChatTabEventDto,
  ChatWorkspaceFrame,
  ChatWorkspaceFrameBus,
  ChatWorkspaceTabEvent,
  Disposable,
} from "@polyth/contracts";
import type { ProfileFrame } from "@polyth/browser";

export type { ChatWorkspaceFrame, ChatWorkspaceTabEvent, ChatWorkspaceFrameBus };

export function frameBusKey(spaceId: string, tabId: string, popupId?: string): string {
  return popupId ? `${spaceId}:${tabId}:popup:${popupId}` : `${spaceId}:${tabId}`;
}

export function createChatWorkspaceFrameBus(deps: {
  resolveSpaceId(tabId: string): string | undefined;
  onFrame(cb: (frame: ProfileFrame) => void): Disposable;
  onEvent(cb: (event: ChatTabEventDto) => void): Disposable;
  setTabStream(tabId: string, visible: boolean, quality?: number): void;
}): ChatWorkspaceFrameBus {
  const latest = new Map<string, ChatWorkspaceFrame>();
  const frameCbs = new Set<(frame: ChatWorkspaceFrame) => void>();
  const eventCbs = new Set<(event: ChatWorkspaceTabEvent) => void>();
  deps.onFrame((frame) => {
    const spaceId = deps.resolveSpaceId(frame.tabId);
    if (!spaceId) return;
    const scoped: ChatWorkspaceFrame = { ...frame, spaceId };
    latest.set(frameBusKey(spaceId, frame.tabId, frame.popupId), scoped);
    for (const cb of [...frameCbs]) cb(scoped);
  });
  deps.onEvent((event) => {
    const spaceId = deps.resolveSpaceId(event.tabId);
    if (!spaceId) return;
    const scoped: ChatWorkspaceTabEvent = { ...event, spaceId };
    for (const cb of [...eventCbs]) cb(scoped);
  });
  return {
    latestFrame(spaceId, tabId, afterRevision = 0, popupId?: string) {
      const frame = latest.get(frameBusKey(spaceId, tabId, popupId));
      if (!frame || frame.revision <= afterRevision) return null;
      return frame;
    },
    onFrame(cb) {
      frameCbs.add(cb);
      return { dispose: () => { frameCbs.delete(cb); } };
    },
    onEvent(cb) {
      eventCbs.add(cb);
      return { dispose: () => { eventCbs.delete(cb); } };
    },
    setTabStream(spaceId, tabId, visible, quality) {
      const owner = deps.resolveSpaceId(tabId);
      if (!owner) return;
      if (spaceId !== null && owner !== spaceId) return;
      deps.setTabStream(tabId, visible, quality);
    },
  };
}
