// The persistent `Add` trigger and its discovery surface.
// The compact composer stays writing-first; this menu owns attachments,
// context and compose utilities. Attach sources (camera, photos, files) are
// tiles; everything else is one labelled row. No outcome appears twice.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import {
  addMenuRows,
  type AddMenuAction,
  type AddMenuContributionRow,
  type AddMenuRow,
  type CatalogState,
  type ComposerCommand,
} from "../composer/discovery.ts";
import type { ComposerAddMenuItem } from "@polyth/web-sdk";
import type { SnippetDef } from "@polyth/session/web-api";
import { openSettingsPage, useStore } from "../store.ts";
import { listSlots, slotVersion, subscribeSlots } from "../slots.ts";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { dismissKeyboard, focusUnlessKeyboardHeld } from "../mobileViewport.ts";
import { useDismissibleMenu } from "./a11y/Menu.ts";
import Popover from "./ui/Popover.tsx";
import SlotHost from "./slots/SlotHost.ts";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import {
  CameraIcon,
  ChevronRightIcon,
  CodeIcon,
  CommandIcon,
  FileIcon,
  ImageIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
  UploadIcon,
  type LucideIcon,
} from "./ui/index.ts";

export interface ComposerAddMenuProps {
  hasProject: boolean;
  hasSession: boolean;
  draftText: string;
  commands: CatalogState<ComposerCommand>;
  snippets: CatalogState<SnippetDef>;
  uploadDisabledReason?: string;
  /** Menu opens upward from the docked composer, downward from the hero. */
  direction: "up" | "down";
  onUpload: () => void;
  /** Opens the camera; offered on touch devices only. */
  onTakePhoto: () => void;
  onChoosePhotos: () => void;
  onInsertMention: () => void;
  onInsertCommand: () => void;
  onInsertSnippet: () => void;
  onEnterShell: () => void;
  /** Protected mode: omit the `!` shell row. */
  shellHidden?: boolean;
  /** Available package contributions, sorted by the host registry. */
  contributions: ComposerAddMenuItem[];
  onActivateContribution: (item: ComposerAddMenuItem) => void;
  /** Optional override for the broader harness/tool configuration surface. */
  onMoreControls?: () => void;
}

interface ExtensionProvider {
  id: string;
  label: string;
  description?: string;
  pluginName?: string;
}

const actionIcons: Record<AddMenuAction, LucideIcon> = {
  camera: CameraIcon,
  photos: ImageIcon,
  upload: UploadIcon,
  mention: FileIcon,
  commands: CommandIcon,
  snippets: CodeIcon,
  shell: TerminalIcon,
};

function ActionIcon({ action }: { action: AddMenuAction }) {
  const Icon = actionIcons[action];
  return <Icon />;
}

/** A touch device (the native shells included) has a camera the capture sheet
 *  can open; a desktop `capture` input degrades to a plain file dialog. */
const touchDevice = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const resolveText = (value: string | (() => string)): string =>
  typeof value === "function" ? value() : value;

export default function ComposerAddMenu(props: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const phone = useShellMode() === "phone";
  const [canCapturePhoto] = useState(touchDevice);
  const sessionId = useStore((state) => state.activeSessionId);
  const projectId = useStore((state) => state.activeProjectId);
  useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);

  const providers: ExtensionProvider[] = listSlots("composer.leading").flatMap((entry) => {
    const meta = entry.meta ?? {};
    const kind = meta.contributionKind;
    if (kind !== "attachment-provider" && kind !== "context-provider") return [];
    const id = typeof meta.contributionId === "string" ? meta.contributionId : "";
    if (!id) return [];
    return [{
      id,
      label: typeof meta.label === "string" ? meta.label : id,
      ...(typeof meta.description === "string" && meta.description ? { description: meta.description } : {}),
      ...(typeof meta.pluginName === "string" ? { pluginName: meta.pluginName } : {}),
    }];
  });
  const activeProvider = providers.find((provider) => provider.id === providerOpen) ?? null;

  const closeToTrigger = () => {
    setOpen(false);
    focusUnlessKeyboardHeld(triggerRef.current);
  };
  const onMenuKeyDown = useDismissibleMenu({
    open,
    menuRef,
    triggerRef,
    onClose: () => setOpen(false),
  });

  const toggleOpen = () => {
    if (open) {
      closeToTrigger();
      return;
    }
    setOpen(true);
    if (phone) void dismissKeyboard();
  };

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button[role='menuitem']:not([aria-disabled='true'])",
    );
    focusUnlessKeyboardHeld(first);
  }, [open]);

  const contributionRows: AddMenuContributionRow[] = props.contributions.map((item) => ({
    id: item.id,
    label: resolveText(item.label),
    order: item.order ?? 0,
    ...(item.description ? { description: resolveText(item.description) } : {}),
  }));
  const contributionById = new Map(props.contributions.map((item) => [item.id, item] as const));

  const rows = addMenuRows({
    hasProject: props.hasProject,
    hasSession: props.hasSession,
    draftText: props.draftText,
    commands: props.commands,
    snippets: props.snippets,
    contributions: contributionRows,
    ...(props.uploadDisabledReason ? { uploadDisabledReason: props.uploadDisabledReason } : {}),
    ...(props.shellHidden ? { shellHidden: true } : {}),
    ...(canCapturePhoto ? { canCapturePhoto: true } : {}),
  });
  const tiles = rows.filter((row) => row.tile);
  const listRows = rows.filter((row) => !row.tile);
  const attachBlock = tiles.find((row) => row.disabledReason)?.disabledReason;

  const activate = (action: AddMenuAction) => {
    setOpen(false);
    switch (action) {
      case "camera": props.onTakePhoto(); break;
      case "photos": props.onChoosePhotos(); break;
      case "upload": props.onUpload(); break;
      case "mention": props.onInsertMention(); break;
      case "commands": props.onInsertCommand(); break;
      case "snippets": props.onInsertSnippet(); break;
      case "shell": props.onEnterShell(); break;
    }
  };

  const activateContribution = (id: string) => {
    const contribution = contributionById.get(id);
    if (!contribution) return;
    setOpen(false);
    // The contribution may mount its own dialog, which records the focused
    // opener in the same commit. Hand it the persistent trigger rather than the
    // menu button that is about to unmount, so closing restores focus here.
    focusUnlessKeyboardHeld(triggerRef.current);
    props.onActivateContribution(contribution);
  };

  const activateRow = (row: AddMenuRow) => {
    if (row.kind !== "item" || row.disabledReason) return;
    if (row.contributionId) { activateContribution(row.contributionId); return; }
    if (row.action) activate(row.action);
  };

  const menuRows = (
    <div
      id="composer-add-menu"
      ref={menuRef}
      role="menu"
      aria-label={tr("composeraddmenu.addContextOrUseAComposerTool")}
      className={`add-menu add-menu-v2 ${props.direction}`}
      onKeyDown={onMenuKeyDown}
    >
      {tiles.length > 0 && (
        <div className="add-menu-attach" role="group" aria-label={tr("composeraddmenu.attach")}>
          <div className="add-menu-tiles" style={{ "--add-menu-tiles": tiles.length } as CSSProperties}>
            {tiles.map((row) => (
              <button
                key={row.id}
                type="button"
                role="menuitem"
                className="add-menu-tile"
                aria-disabled={row.disabledReason ? true : undefined}
                aria-label={row.description ?? row.label}
                aria-describedby="composer-add-attach-note"
                title={row.disabledReason ?? row.description}
                onClick={() => activateRow(row)}
              >
                <span className="add-menu-tile-icon" aria-hidden="true">
                  {row.action && <ActionIcon action={row.action} />}
                </span>
                <span className="add-menu-tile-label" aria-hidden="true">{row.label}</span>
              </button>
            ))}
          </div>
          <p
            id="composer-add-attach-note"
            className={attachBlock ? "add-menu-attach-note add-menu-reason" : "add-menu-attach-note"}
          >
            {attachBlock ?? tr("composer.discovery.copiesFilesIntoThisProjectSInbox")}
          </p>
        </div>
      )}

      <div className="add-menu-sections">
        {listRows.map((row) => row.kind === "group" ? (
          <div key={row.id} className="add-menu-group" role="presentation">{row.label}</div>
        ) : (
          <button
            key={row.id}
            type="button"
            role="menuitem"
            className="add-menu-item"
            aria-disabled={row.disabledReason ? true : undefined}
            onClick={() => activateRow(row)}
          >
            {(row.action || (row.contributionId && contributionById.get(row.contributionId)?.icon)) && (
              <span className="add-menu-item-icon" aria-hidden="true">
                {row.action
                  ? <ActionIcon action={row.action} />
                  : contributionById.get(row.contributionId!)?.icon?.()}
              </span>
            )}
            <span className="add-menu-main">
              <span className="add-menu-label">{row.label}</span>
              {row.description && <span className="add-menu-desc">{row.description}</span>}
              {row.disabledReason && <span className="add-menu-reason">{row.disabledReason}</span>}
              {row.detail && <span className="add-menu-detail">{row.detail}</span>}
            </span>
            {row.hint && (
              <span className="add-menu-meta">
                <span className="add-menu-hint" aria-hidden="true">{row.hint}</span>
              </span>
            )}
          </button>
        ))}

        {providers.length > 0 && (
          <>
            <div className="add-menu-group" role="presentation">{tr("composeraddmenu.extensions")}</div>
            {providers.map((provider) => (
              <button
                key={`extension-provider-${provider.id}`}
                type="button"
                role="menuitem"
                className="add-menu-item"
                onClick={() => {
                  setOpen(false);
                  setProviderOpen(provider.id);
                }}
              >
                <span className="add-menu-main">
                  <span className="add-menu-label">{provider.label}</span>
                  {(provider.description || provider.pluginName) && (
                    <span className="add-menu-desc">{provider.description ?? provider.pluginName}</span>
                  )}
                </span>
                {provider.pluginName && <span className="add-menu-detail">{provider.pluginName}</span>}
              </button>
            ))}
          </>
        )}

        <button
          type="button"
          role="menuitem"
          className="add-menu-item add-menu-more"
          onClick={() => {
            setOpen(false);
            (props.onMoreControls ?? (() => openSettingsPage("harnesses")))();
          }}
        >
          <span className="add-menu-more-icon" aria-hidden="true"><SettingsIcon /></span>
          <span className="add-menu-main">
            <span className="add-menu-label">{tr("composeraddmenu.moreComposerTools")}</span>
          </span>
          <span className="add-menu-more-arrow" aria-hidden="true"><ChevronRightIcon /></span>
        </button>
      </div>
    </div>
  );

  return (
    <span className="composer-add">
      <button
        ref={triggerRef}
        type="button"
        className="chip composer-add-trigger"
        aria-label={tr("composeraddmenu.addFilesContextAndTools")}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { "aria-controls": "composer-add-menu" } : {})}
        onClick={toggleOpen}
      >
        <span aria-hidden="true" className="composer-add-icon"><PlusIcon /></span>
        <span className="composer-add-label">{tr("common.add")}</span>
      </button>
      {open && (
        <Popover
          open
          onClose={closeToTrigger}
          anchorRef={triggerRef}
          side={props.direction === "up" ? "up" : "down"}
          align="start"
          compact={phone}
          ariaLabel={tr("composeraddmenu.addFilesContextAndTools")}
          className="composer-add-pop"
          role="presentation"
          restoreFocusRef={triggerRef}
        >
          {menuRows}
        </Popover>
      )}
      <ResponsiveOverlay
        open={activeProvider !== null}
        onClose={() => { setProviderOpen(null); focusUnlessKeyboardHeld(triggerRef.current); }}
        title={activeProvider?.label ?? tr("composeraddmenu.extensionProvider")}
        desktop="dialog"
        phone="sheet"
        anchorRef={triggerRef}
        sheetSize="tall"
        dialogSize="md"
        restoreFocusRef={triggerRef}
      >
        {activeProvider && (
          <SlotHost
            slot="composer.leading"
            context={{
              sessionId,
              projectId,
              presentation: "picker",
              selectedContributionId: activeProvider.id,
            }}
          />
        )}
      </ResponsiveOverlay>
    </span>
  );
}
