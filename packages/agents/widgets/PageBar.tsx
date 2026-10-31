import type { ReactNode } from "react";
import { setSidebarOpen, useStore } from "../../../apps/web/src/store.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { IconButton, MenuIcon } from "../../../apps/web/src/components/ui/index.ts";

/** On a phone the page replaces Chat, so it carries Chat's way back to the
 *  navigator: the same button in the same corner. */
export function NavigatorButton() {
  const open = useStore((state) => state.sidebarOpen);
  if (useShellMode() !== "phone") return null;
  return (
    <IconButton
      icon={MenuIcon}
      size="lg"
      variant="ghost"
      className="agents-nav-button"
      label={tr("mobile.island.openNavigation")}
      aria-expanded={open}
      onClick={() => setSidebarOpen(true)}
    />
  );
}

/** The top of a simple agents page (home, a new agent): its title, and on a
 *  phone the way back to the navigator. */
export default function PageBar({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="agents-bar">
      <div className="agents-bar-inner">
        <NavigatorButton />
        <h1 className="agents-bar-title">{title}</h1>
        {actions && <div className="agents-bar-actions">{actions}</div>}
      </div>
    </header>
  );
}
