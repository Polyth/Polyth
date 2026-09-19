import { setRailPlugin, setSidebarOpen, useStore } from "../../store.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import {
  hideMobileWorkspaceHome,
  showMobileWorkspaceHome,
  useMobileWorkspaceNavigation,
} from "../../mobileWorkspaceNavigation.ts";
import { GlassIsland, IconButton, LayersIcon, MenuIcon } from "../ui/index.ts";
import { tr } from "../../i18n/index.ts";
import type { TranslationKey } from "../../i18n/types.ts";
import { Tools } from "./MobileSessionHeader.tsx";

const VIEW_LABEL: Record<string, TranslationKey> = {
  goals: "statusbar.goals",
  multirun: "statusbar.workflows",
  workflow: "statusbar.workflows",
  fusion: "statusbar.fusion",
  walkthrough: "statusbar.walkthrough",
  schedule: "statusbar.schedule",
  github: "statusbar.github",
};

/** Floating three-segment bar for non-chat phone views.
 *  Mirrors MobileSessionHeader geometry so both shells share the same
 *  safe-area insets, blur, and touch-target rhythm. */
export default function MobileViewHeader() {
  const view = useStore((s) => s.activeView);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const capabilities = useResolvedCapabilities();
  const workspaceNav = useMobileWorkspaceNavigation();
  const label = tr(VIEW_LABEL[view] ?? "statusbar.chat");

  const openWorkspaceNavigation = () => {
    const remembered = workspaceNav.lastPackageId;
    const capability = remembered
      ? capabilities.find(({ descriptor }) => descriptor.id === remembered && descriptor.available())
      : undefined;
    if (capability) {
      hideMobileWorkspaceHome();
      capability.descriptor.open();
      return;
    }
    showMobileWorkspaceHome();
  };

  return <>
    <div className="mobile-session-floats" aria-label="View navigation">
      <GlassIsland className="mobile-float-navigation">
        <IconButton icon={MenuIcon} label="Open navigation" size="lg" variant="ghost" className="mobile-float-button" aria-expanded={sidebarOpen} onClick={() => {
          hideMobileWorkspaceHome();
          setRailPlugin(null);
          setSidebarOpen(true);
        }} />
      </GlassIsland>
      <GlassIsland className="mobile-view-title" aria-label={label}><span>{label}</span></GlassIsland>
      <GlassIsland className="mobile-float-actions">
        <IconButton icon={LayersIcon} label="Open tools" size="lg" variant="ghost" aria-expanded={workspaceNav.homeOpen} onClick={openWorkspaceNavigation} />
      </GlassIsland>
    </div>
    {workspaceNav.homeOpen && <Tools onClose={hideMobileWorkspaceHome} />}
  </>;
}
