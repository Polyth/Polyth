export interface NativeBackState {
  overlayOpen: boolean;
  drawerOpen: boolean;
  workspacePaneOpen: boolean;
  railOpen: boolean;
}

export interface NativeBackActions {
  dismissEscapeLayer(): boolean;
  closeOverlay(): void;
  closeDrawer(): void;
  closeWorkspacePane(): void;
  closeRail(): void;
  navigateBack(): boolean;
}

/** D15 native-back contract. Transient escape-stack layers get first refusal,
 * then shell surfaces close from front to back, then in-app history navigates.
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
  if (state.drawerOpen) {
    actions.closeDrawer();
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
  return actions.navigateBack();
}
