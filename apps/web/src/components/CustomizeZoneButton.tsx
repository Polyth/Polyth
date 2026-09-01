import { openSettingsPage } from "../store.ts";
import { tr } from "../i18n/index.ts";
import { EditIcon, IconButton } from "./ui/index.ts";

export default function CustomizeZoneButton({ className = "" }: { className?: string }) {
  return (
    <IconButton
      className={`zone-customize-trigger zone-edit-button${className ? ` ${className}` : ""}`}
      icon={EditIcon}
      size="sm"
      variant="ghost"
      label={tr("settingsview.customize")}
      onClick={() => openSettingsPage("widgets")}
    />
  );
}
