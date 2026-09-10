// F2: shared per-row file actions for the Files and Changes panels —
// Open / Copy path / Add to chat (attachment pill on the active composer).
import { copyText } from "../../../apps/web/src/utils.ts";
import { attachProjectFile } from "../../../apps/web/src/attachments.ts";
import { getState, setUiError } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { IconButton, Menu, MoreIcon } from "../../../apps/web/src/components/ui/index.ts";

export default function FileRowActions({ projectId, path, onOpen }: {
  projectId: string;
  path: string;
  /** Row-appropriate open action (viewer, diff, …). Omitted = no Open item. */
  onOpen?: () => void;
}) {
  const addToChat = () => {
    void attachProjectFile(projectId, getState().activeSessionId, path).then((r) => {
      if (!r.ok) setUiError(tr("composer.couldNotAttach", { reason: r.reason }));
    });
  };

  return (
    <span
      className="file-row-actions"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Menu
        label={tr("filerowactions.actionsForValue", { path })}
        title={tr("filerowactions.actionsForValue", { path })}
        align="end"
        entries={[
          ...(onOpen ? [{ id: "open", label: tr("common.open"), onSelect: onOpen }] : []),
          { id: "copy", label: tr("filerowactions.copyPath"), onSelect: () => void copyText(path) },
          { id: "chat", label: tr("filerowactions.addToChat"), onSelect: addToChat },
        ]}
      >
        {(trigger) => (
          <IconButton
            {...trigger}
            icon={MoreIcon}
            size="sm"
            variant="ghost"
            label={tr("filerowactions.actionsForValue", { path })}
          />
        )}
      </Menu>
    </span>
  );
}
