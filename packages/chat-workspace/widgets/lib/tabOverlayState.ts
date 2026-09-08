import type { ChatTabEventDto, ChatTabStateDto } from "@polyth/contracts";

export interface TabOverlayModel {
  approval: { origin: string; reason: string; url?: string } | null;
  popups: Array<{ popupId: string; url?: string }>;
  fileChooser: boolean;
  downloadBlocked: boolean;
  crashed: boolean;
  unreachable: { domain: string } | null;
  profileRestarted: boolean;
  profileLocked: boolean;
  liveTabCount: number;
}

export function emptyOverlayModel(): TabOverlayModel {
  return {
    approval: null,
    popups: [],
    fileChooser: false,
    downloadBlocked: false,
    crashed: false,
    unreachable: null,
    profileRestarted: false,
    profileLocked: false,
    liveTabCount: 0,
  };
}

export function overlayFromState(state: ChatTabStateDto): TabOverlayModel {
  return {
    approval: state.pendingApproval ?? null,
    popups: state.pendingPopups ?? [],
    fileChooser: Boolean(state.pendingFileChooser),
    downloadBlocked: Boolean(state.downloadBlocked),
    crashed: Boolean(state.crashed),
    unreachable: state.unreachable ? { domain: tryDomain(state.tab.url) } : null,
    profileRestarted: Boolean(state.profileRestarted),
    profileLocked: false,
    liveTabCount: state.liveTabCount ?? 0,
  };
}

export function reduceTabOverlay(model: TabOverlayModel, event: ChatTabEventDto): TabOverlayModel {
  const next = { ...model, popups: [...model.popups] };
  switch (event.kind) {
    case "approval-required":
      next.approval = {
        origin: event.origin ?? "",
        reason: event.reason ?? event.message ?? "",
        ...(event.url ? { url: event.url } : {}),
      };
      break;
    case "popup-opened":
      if (event.popupId) next.popups.push({ popupId: event.popupId, ...(event.url ? { url: event.url } : {}) });
      break;
    case "popup-closed":
      if (event.popupId) next.popups = next.popups.filter((p) => p.popupId !== event.popupId);
      break;
    case "file-chooser-opened":
      next.fileChooser = true;
      break;
    case "download-blocked":
      next.downloadBlocked = true;
      break;
    case "crash":
      next.crashed = true;
      break;
    case "profile-locked":
      next.profileLocked = true;
      break;
    case "navigation":
      next.unreachable = null;
      next.crashed = false;
      break;
    default:
      break;
  }
  return next;
}

function tryDomain(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function dismissDownloadBlocked(model: TabOverlayModel): TabOverlayModel {
  return { ...model, downloadBlocked: false };
}

export function dismissFileChooser(model: TabOverlayModel): TabOverlayModel {
  return { ...model, fileChooser: false };
}

export function dismissApproval(model: TabOverlayModel): TabOverlayModel {
  return { ...model, approval: null };
}

export function clearCrash(model: TabOverlayModel): TabOverlayModel {
  return { ...model, crashed: false };
}

export function setProfileLocked(model: TabOverlayModel): TabOverlayModel {
  return { ...model, profileLocked: true };
}

export function clearProfileLocked(model: TabOverlayModel): TabOverlayModel {
  return { ...model, profileLocked: false };
}
