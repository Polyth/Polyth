export type ScreencastPhase = "idle" | "subscribing" | "active" | "paused" | "closed";

export interface ScreencastSubscriptionState {
  tabId: string | null;
  visible: boolean;
  phase: ScreencastPhase;
  revision: number;
}

export function initialScreencastState(): ScreencastSubscriptionState {
  return { tabId: null, visible: true, phase: "idle", revision: 0 };
}

/** Pure transition for tab switch, visibility, and unmount. */
export function transitionScreencast(
  state: ScreencastSubscriptionState,
  action:
    | { type: "select-tab"; tabId: string | null }
    | { type: "set-visible"; visible: boolean }
    | { type: "frame"; revision: number }
    | { type: "unmount" },
): ScreencastSubscriptionState {
  switch (action.type) {
    case "select-tab": {
      if (!action.tabId) {
        return { ...state, tabId: null, phase: "idle", revision: 0 };
      }
      if (action.tabId === state.tabId) return state;
      return {
        tabId: action.tabId,
        visible: state.visible,
        phase: state.visible ? "subscribing" : "paused",
        revision: 0,
      };
    }
    case "set-visible": {
      if (!state.tabId) return { ...state, visible: action.visible };
      if (action.visible === state.visible) return state;
      return {
        ...state,
        visible: action.visible,
        phase: action.visible ? "subscribing" : "paused",
      };
    }
    case "frame": {
      if (state.phase === "closed" || !state.tabId || !state.visible) return state;
      return { ...state, phase: "active", revision: action.revision };
    }
    case "unmount":
      return { tabId: null, visible: false, phase: "closed", revision: 0 };
    default:
      return state;
  }
}

export function shouldSubscribe(state: ScreencastSubscriptionState): boolean {
  return state.phase === "subscribing" && state.tabId !== null && state.visible;
}

export function acceptsFrames(state: ScreencastSubscriptionState): boolean {
  return state.phase !== "closed" && state.tabId !== null && state.visible;
}

export interface ScreencastSubscribeMessage {
  type: "chat-workspace/subscribe";
  tabId: string;
  visible: boolean;
  afterRevision: number;
  quality: number;
}

export function buildSubscribeMessage(
  tabId: string,
  visible: boolean,
  afterRevision: number,
  quality = 60,
): ScreencastSubscribeMessage {
  return { type: "chat-workspace/subscribe", tabId, visible, afterRevision, quality };
}
