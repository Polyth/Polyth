import { useLayoutEffect, useRef } from "react";
import SettingsView from "./SettingsView.tsx";

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const previouslyOpen = useRef(open);
  useLayoutEffect(() => {
    if (previouslyOpen.current && !open) {
      // The owner can close Settings directly (route/store changes), bypassing
      // SettingsView's close callback. Restore after that commit so removing
      // the focused dialog cannot leave BODY as the final active element.
      document.querySelector<HTMLElement>(".mobile-shortcut-settings, .header-profile")?.focus();
    }
    previouslyOpen.current = open;
  }, [open]);

  if (!open) return null;
  return <SettingsView onClose={onClose} />;
}
