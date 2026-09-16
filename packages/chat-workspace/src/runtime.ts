export type ChatWorkspaceRuntimeKind = "desktop-local" | "server-remote";

export interface ChatWorkspaceRuntimeCapability {
  kind: ChatWorkspaceRuntimeKind;
  available: boolean;
  deviceId?: string;
  deviceName?: string;
  reason?: string;
  /** Local rendering means provider pixels and direct input never traverse the server. */
  localRendering: boolean;
  /** Browser login/profile state stays on the execution device. */
  localProfileState: boolean;
}

export interface ChatWorkspaceRuntimePreference {
  /** Prefer a capable desktop runtime; fall back only when explicitly allowed. */
  mode: "local-first" | "local-only" | "remote";
  deviceId?: string;
  allowRemoteFallback: boolean;
}

export interface ChatWorkspaceRuntimeSelection {
  selected: ChatWorkspaceRuntimeCapability | null;
  candidates: ChatWorkspaceRuntimeCapability[];
  waitingForDevice: boolean;
  usedRemoteFallback: boolean;
}

// Default is the local Desktop runtime: provider pixels and logins stay on the
// device. Streaming a server-side Chromium is never automatic — the user picks
// "Remote server" in the runtime menu when they want it.
export const DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE: ChatWorkspaceRuntimePreference = {
  mode: "local-first",
  allowRemoteFallback: false,
};

/**
 * Pure runtime policy. Device discovery and transport deliberately live outside
 * chat-workspace so the package can consume the canonical Polyth device layer
 * instead of growing a second pairing protocol.
 */
export function selectChatWorkspaceRuntime(
  candidates: readonly ChatWorkspaceRuntimeCapability[],
  preference: ChatWorkspaceRuntimePreference = DEFAULT_CHAT_WORKSPACE_RUNTIME_PREFERENCE,
): ChatWorkspaceRuntimeSelection {
  const available = candidates.filter((candidate) => candidate.available);
  const local = available.filter((candidate) => candidate.kind === "desktop-local");
  const remote = available.find((candidate) => candidate.kind === "server-remote") ?? null;

  const requestedLocal = preference.deviceId
    ? local.find((candidate) => candidate.deviceId === preference.deviceId) ?? null
    : local[0] ?? null;

  if (preference.mode === "remote") {
    return {
      selected: remote,
      candidates: [...candidates],
      waitingForDevice: false,
      usedRemoteFallback: false,
    };
  }

  if (requestedLocal) {
    return {
      selected: requestedLocal,
      candidates: [...candidates],
      waitingForDevice: false,
      usedRemoteFallback: false,
    };
  }

  if (preference.mode === "local-first" && preference.allowRemoteFallback && remote) {
    return {
      selected: remote,
      candidates: [...candidates],
      waitingForDevice: false,
      usedRemoteFallback: true,
    };
  }

  return {
    selected: null,
    candidates: [...candidates],
    waitingForDevice: true,
    usedRemoteFallback: false,
  };
}
