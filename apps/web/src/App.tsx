import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import Navigation from "./components/Navigation.tsx";
import Main from "./components/Main.tsx";
import ContextRail from "./components/ContextRail.tsx";
import StatusBar from "./components/StatusBar.tsx";
import CommandPalette from "./components/CommandPalette.tsx";
import SessionSearch from "./components/SessionSearch.tsx";
import ArchivedSessionsDialog from "./components/ArchivedSessionsDialog.tsx";
import ShareSessionDialog from "./components/ShareSessionDialog.tsx";
import SettingsModal from "./components/SettingsModal.tsx";
import ProjectSetupFlowDialog from "./components/ProjectSetupFlowDialog.tsx";
import ShellIntroTour from "./components/ShellIntroTour.tsx";
import ViewErrorBoundary from "./components/ViewErrorBoundary.ts";
import { getState, setOverlay, useStore } from "./store.ts";
import { useWorkbenchLayout } from "./workbench/store.ts";
import { useWorkbenchShellPresentation } from "./workbench/profileNavigation.ts";
import { decideFirstRunSurface, markAutoPickerOffered, wasAutoPickerOffered } from "./projectOnboarding.ts";
import {
  decideShellIntroAdmission,
  getShellIntroPrefs,
  getShellIntroState,
  isShellIntroSuspended,
  openShellIntro,
  resumeShellIntro,
  SHELL_INTRO_RESUME_DELAY_MS,
  SHELL_INTRO_VERSION,
  subscribeShellIntro,
  subscribeShellIntroPrefs,
  wasShellIntroOffered,
} from "./shellIntro.ts";
import { isClientSettingsSettled, subscribeClientSettingsSettled } from "./settingsSync.ts";
import { LiveRegion } from "./components/a11y/live.tsx";
import WorktreeSessionDialog from "./components/WorktreeSessionDialog.tsx";
import "./builtinCapabilities.ts";
import Header from "./components/Header.tsx";
import AlertDialog from "./components/AlertDialog.tsx";
import { useWorkspaceMode } from "./widgets/workspaceMode.ts";
import { useShellMode, useViewportBelow } from "./responsiveShell.ts";
import { automaticSidebarRail, setAutomaticSidebarRail } from "./sidebarLayout.ts";
import { setShellMirrored, shellDirectionFor, useDocumentDirection } from "./shellDirection.ts";
import BackgroundQuickPicker from "./components/BackgroundPicker.tsx";
import ConnectionFeedback from "./components/ConnectionFeedback.tsx";
import NotificationStack from "./notify/NotificationStack.tsx";
import SlotHost from "./components/slots/SlotHost.ts";
import { useUiSettings } from "./uiPrefs.ts";
import { resolveShellLayout, usePublishShellLayout } from "./shellLayout.ts";

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
  const paneMode = useStore((s) => s.paneMode);
  const railPlugin = useStore((s) => s.railPlugin);
  const shellPresentation = useWorkbenchShellPresentation();
  const ui = useUiSettings();
  const workbenchLayout = useWorkbenchLayout();
  const [primarySurface, endSurface] = shellPresentation.splitSurfaces ?? [];
  const focusedMode = shellPresentation.focused;
  const focusedSwapped = focusedMode
    && primarySurface !== undefined
    && endSurface !== undefined
    && workbenchLayout.regions.primary.surfaces.includes(endSurface)
    && workbenchLayout.regions.end.surfaces.includes(primarySurface);
  const focusedSplit = focusedMode
    && primarySurface !== undefined
    && endSurface !== undefined
    && shellMode === "wide"
    && paneMode === "pinned"
    && railPlugin === endSurface
    && !paneFullscreen;
  // A focused profile's `sidebarRailBelow` hint rests the wide sidebar on its
  // project rail. In-memory presentation only (sidebarLayout.ts): the person's
  // sidebar preference is never written. Layout effect: no wide-sidebar flash.
  const viewportBelowRail = useViewportBelow(shellPresentation.sidebarRailBelow);
  const automaticRail = automaticSidebarRail({
    wide: shellMode === "wide",
    sidebarRailBelow: shellPresentation.sidebarRailBelow,
    viewportBelow: viewportBelowRail,
  });
  useLayoutEffect(() => {
    setAutomaticSidebarRail(automaticRail);
  }, [automaticRail]);
  useEffect(() => () => setAutomaticSidebarRail(false), []);
  // A mirrored profile flips the wide shell's frames, not its content: one
  // `dir` on .app-shell, the document direction back on each content root
  // (shellDirection.ts). Profile-level, so closing the work surface never
  // moves the sidebar back across the window.
  const shellDirection = shellDirectionFor(
    (shellPresentation.mirrored || ui.mirrorLayout) && shellMode === "wide",
    useDocumentDirection(),
  );
  useLayoutEffect(() => {
    setShellMirrored(shellDirection.mirrored);
  }, [shellDirection.mirrored]);
  useEffect(() => () => setShellMirrored(false), []);
  // Full-height columns (Settings → Appearance → Window layout).
  usePublishShellLayout(resolveShellLayout(ui, shellMode));

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

  // Coordinator: one pure decision over project-registry truth.
  // Per-project setup is not an input to picker admission — the picker opens
  // only from a ready-empty registry, once per document, and never over another
  // overlay.
  const surface = decideFirstRunSurface({
    registryStatus,
    projectCount,
    pickerOfferedThisDocument: wasAutoPickerOffered(),
  });

  // A new account meets the interface tour first; the
  // automatic project picker waits until the tour is done or dismissed, so the
  // tour's add-project step leads straight into it.
  const settingsSettled = useSyncExternalStore(subscribeClientSettingsSettled, isClientSettingsSettled);
  const introSeenVersion = useSyncExternalStore(subscribeShellIntroPrefs, () => getShellIntroPrefs().seenVersion);
  const introOpen = useSyncExternalStore(subscribeShellIntro, () => getShellIntroState() !== null);
  const introAdmission = introOpen ? "wait" : decideShellIntroAdmission({
    settingsSettled,
    seen: introSeenVersion >= SHELL_INTRO_VERSION,
    registryStatus,
    overlayOpen: overlay !== null,
    offeredThisDocument: wasShellIntroOffered(),
  });

  useEffect(() => {
    if (introAdmission === "open") openShellIntro({ auto: true });
  }, [introAdmission]);

  // The tour's add-project button pauses it for the project dialog; once that
  // (or anything it led to) has closed, the tour continues where it left off.
  const introSuspended = useSyncExternalStore(subscribeShellIntro, isShellIntroSuspended);
  useEffect(() => {
    if (!introSuspended || overlay !== null) return;
    // Let the dialog's exit motion and the new project's rails settle first.
    const timer = window.setTimeout(() => {
      resumeShellIntro(getState().projectRegistry.projects.map((project) => project.id));
    }, SHELL_INTRO_RESUME_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [introSuspended, overlay]);

  useEffect(() => {
    if (surface === "project-picker" && overlay === null && introAdmission === "done") {
      markAutoPickerOffered();
      setOverlay("project-picker");
    }
  }, [surface, overlay, introAdmission]);

  return (
    <div
      className={`app mode-${workspaceMode} view-${activeView}${focusedMode ? " workspace-focus-mode" : ""}${focusedSplit && focusedSwapped ? " workspace-focus-swap" : ""}`}
      data-workspace-focus={focusedMode ? "true" : undefined}
      data-workspace-split={focusedSplit ? "true" : undefined}
      data-shell-mirror={shellDirection.mirrored ? "true" : undefined}
    >
      <Header />
      <div className="app-shell" dir={shellDirection.frameDir}>
        <Navigation />
        {/* While a workspace surface covers the workspace, Chat
            stays mounted underneath but is inert and out of the a11y tree — it
            consumes no hit area and cannot retain sequential focus. */}
        <div className="workspace" dir={shellDirection.contentDir} inert={paneFullscreen} aria-hidden={paneFullscreen || undefined}>
          <ViewErrorBoundary resetKey={viewResetKey}>
            <Main />
          </ViewErrorBoundary>
          {shellMode !== "phone" && <StatusBar />}
        </div>
        <ContextRail />
      </div>
      <BackgroundQuickPicker />
      <ConnectionFeedback />
      <SlotHost slot="app.layers" />
      <NotificationStack />
      <AlertDialog />
      {overlay === "palette" && <CommandPalette />}
      {overlay === "search" && <SessionSearch />}
      {overlay === "archived-sessions" && <ArchivedSessionsDialog />}
      {overlay === "session-sharing" && <ShareSessionDialog />}
      {overlay === "project-picker" && <ProjectSetupFlowDialog onClose={() => setOverlay(null)} />}
      {overlay === "worktree-session" && <WorktreeSessionDialog />}
      <SettingsModal open={overlay === "settings"} onClose={() => setOverlay(null)} />
      <ShellIntroTour />
      <LiveRegion />
    </div>
  );
}