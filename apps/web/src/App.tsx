import { useEffect } from "react";
import Navigation from "./components/Navigation.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSearch from "./components/SessionSearch.tsx";
import SettingsModal from "./components/SettingsModal.tsx";
import ProjectSetupFlowDialog from "./components/ProjectSetupFlowDialog.tsx";
import ViewErrorBoundary from "./components/ViewErrorBoundary.ts";
import { clearUiError, setOverlay, useStore } from "./store.ts";
import { decideFirstRunSurface, markAutoPickerOffered, wasAutoPickerOffered } from "./projectOnboarding.ts";
import { LiveRegion } from "./components/a11y/live.tsx";
import WorktreeSessionDialog from "./components/WorktreeSessionDialog.tsx";
import "./builtinCapabilities.ts";
import Header from "./components/Header.tsx";
import AlertDialog from "./components/AlertDialog.tsx";
import { useWorkspaceMode } from "./widgets/workspaceMode.ts";
import { useShellMode } from "./responsiveShell.ts";
import { tr } from "./i18n/index.ts";
import { Button, Icon, IconButton, Notice } from "./components/ui/index.ts";
import {
  BlockedIcon,
  CloseIcon,
  ErrorIcon,
  LockIcon,
  OfflineIcon,
  ServerErrorIcon,
  StorageIcon,
  type LucideIcon,
} from "./components/ui/icons.ts";
import { presentUiError, type UiErrorCategory } from "./errorPresentation.ts";
import BackgroundQuickPicker from "./components/BackgroundPicker.tsx";

// One contextual glyph per failure family keeps the toast legible at a glance
// without changing where the error came from or how long it stays.
const ERROR_CATEGORY_ICON: Record<UiErrorCategory, LucideIcon> = {
  network: OfflineIcon,
  auth: LockIcon,
  storage: StorageIcon,
  server: ServerErrorIcon,
  blocked: BlockedIcon,
  error: ErrorIcon,
};

function ErrorBanner() {
  const message = useStore((s) => s.uiError);
  const action = useStore((s) => s.uiErrorAction);
  if (!message) return null;
  const view = presentUiError(message);
  const CategoryIcon = ERROR_CATEGORY_ICON[view.category];
  return (
    <Notice
      key={message}
      tone="error"
      className="error-banner"
      role="alert"
      data-category={view.category}
      leading={(
        <IconButton
          icon={CloseIcon}
          label={tr("app.dismissError")}
          size="sm"
          className="error-banner-close"
          onClick={clearUiError}
        />
      )}
      icon={<span className="error-banner-glyph"><Icon icon={CategoryIcon} size="md" /></span>}
      iconPosition="trailing"
      heading={view.title || undefined}
    >
      {view.description && <div className="error-banner-detail">{view.description}</div>}
      {action && (
        <Button
          size="sm"
          variant="ghost"
          className="error-banner-action"
          onClick={() => { clearUiError(); void action.run(); }}
        >
          {action.label}
        </Button>
      )}
    </Notice>
  );
}

export default function App() {
  const overlay = useStore((s) => s.overlay);
  const viewResetKey = useStore(
    (s) => `${s.activeProjectId ?? ""}:${s.activeSessionId ?? ""}:${s.activeView}`,
  );
  const registryStatus = useStore((s) => s.projectRegistry.status);
  const projectCount = useStore((s) => s.projectRegistry.projects.length);
  const paneFullscreen = useStore((s) => s.paneFullscreen);
  const activeView = useStore((s) => s.activeView);
  const workspaceMode = useWorkspaceMode();
  const shellMode = useShellMode();

  useEffect(() => {
    if (workspaceMode === "edit") document.body.dataset.uiEditing = "true";
    else delete document.body.dataset.uiEditing;
    return () => { delete document.body.dataset.uiEditing; };
  }, [workspaceMode]);

  useEffect(() => {
    const openSettings = () => setOverlay("settings");
    window.addEventListener("polyth:open-settings", openSettings);
    return () => window.removeEventListener("polyth:open-settings", openSettings);
  }, []);

  // UX-ONBOARDING coordinator: one pure decision over project-registry truth.
  // Per-project setup is not an input to picker admission — the picker opens
  // only from a ready-empty registry, once per document, and never over another
  // overlay.
  const surface = decideFirstRunSurface({
    registryStatus,
    projectCount,
    pickerOfferedThisDocument: wasAutoPickerOffered(),
  });

  useEffect(() => {
    if (surface === "project-picker" && overlay === null) {
      markAutoPickerOffered();
      setOverlay("project-picker");
    }
  }, [surface, overlay]);

  return (
    <div className={`app mode-${workspaceMode} view-${activeView}`}>
      <Header />
      <div className="app-shell">
        <Navigation />
        {/* UX-PANE-MODEL: while a workspace surface covers the workspace, Chat
            stays mounted underneath but is inert and out of the a11y tree — it
            consumes no hit area and cannot retain sequential focus. */}
        <div className="workspace" inert={paneFullscreen} aria-hidden={paneFullscreen || undefined}>
          <ViewErrorBoundary resetKey={viewResetKey}>
            <Main />
          </ViewErrorBoundary>
          {shellMode !== "phone" && <StatusBar />}
        </div>
        <ContextRail />
      </div>
      <BackgroundQuickPicker />
      <ErrorBanner />
      <AlertDialog />
      {overlay === "palette" && <CommandPalette />}
      {overlay === "search" && <SessionSearch />}
      {overlay === "project-picker" && <ProjectSetupFlowDialog onClose={() => setOverlay(null)} />}
      {overlay === "worktree-session" && <WorktreeSessionDialog />}
      <SettingsModal open={overlay === "settings"} onClose={() => setOverlay(null)} />
      <LiveRegion />
    </div>
  );
}