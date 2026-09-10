export interface NativeBackState {
  overlayOpen: boolean;
  drawerOpen: boolean;
  workspacePaneOpen: boolean;
  railOpen: boolean;
}

export interface NativeBackActions {
  dismissEscapeLayer(): boolean;
  /** Selection is ephemeral UI, so clear it before changing route history. */
  dismissSelection?(): boolean;
  closeOverlay(): void;
  closeDrawer(): void;
  closeWorkspacePane(): void;
  closeRail(): void;
  navigateBack(): boolean;
}

function dismissDocumentSelection(): boolean {
  if (typeof document === "undefined") return false;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return false;
  selection.removeAllRanges();
  return true;
}

/** D15 native-back contract. Transient escape-stack layers get first refusal,
 * then shell surfaces close from front to back, then selection and in-app
 * history navigate. A workspace pane is foreground content, so it closes
 * before the navigation drawer.
 * False means the native host may background the app. */
export function handleNativeBack(
  state: NativeBackState,
  actions: NativeBackActions,
): boolean {
  if (actions.dismissEscapeLayer()) return true;
  if (state.overlayOpen) {
    actions.closeOverlay();
    return true;
  }
  if (state.workspacePaneOpen) {
    actions.closeWorkspacePane();
    return true;
  }
  if (state.railOpen) {
    actions.closeRail();
    return true;
  }
  if (state.drawerOpen) {
    actions.closeDrawer();
    return true;
  }
  if (actions.dismissSelection?.() ?? dismissDocumentSelection()) return true;
  return actions.navigateBack();
}
