// The design-system parts the web SDK hands to packages beyond the original
// controls (`host.ui.components`, `iconSet`, `tabIds`, `confirm`). Each one is
// the shell's own component, so a package that uses it looks and behaves like
// the rest of the app and follows every later change to it.
import type { AttachmentRef } from "@polyth/contracts";
import { WEB_ICON_NAMES, type WebIconComponent, type WebIconName, type WebIconSet, type WebMediaViewerProps, type WebPackageHost } from "@polyth/web-sdk";
import {
  Badge,
  Dialog,
  Icon,
  Notice,
  Skeleton,
  Spinner,
  Switch,
  TabPanel,
  confirmAlert,
  tabId,
  tabPanelId,
} from "../components/ui/index.ts";
import * as icons from "../components/ui/icons.ts";
import Picker from "../components/Picker.tsx";
import { Row, Section } from "../components/settings/parts.tsx";
import AttachmentPreview from "../components/AttachmentPreview.tsx";

type HostUi = WebPackageHost["ui"];
type Components = HostUi["components"];

/** SDK glyph names that are aliases of a differently named shell glyph. */
const ICON_ALIASES: Partial<Record<WebIconName, keyof typeof icons>> = { FitIcon: "ScanIcon" };

function buildIconSet(): WebIconSet {
  const set = {} as Record<WebIconName, WebIconComponent>;
  const all = icons as unknown as Record<string, WebIconComponent | undefined>;
  for (const name of WEB_ICON_NAMES) {
    const glyph = all[ICON_ALIASES[name] ?? name];
    if (!glyph) throw new Error(`host iconSet: ${name} has no shell glyph`);
    set[name] = glyph;
  }
  return Object.freeze(set);
}

function mediaKind(mime: string | undefined): { mime: string; kind: "image" | "file" } {
  const resolved = mime || "image/*";
  return { mime: resolved, kind: resolved.startsWith("image/") ? "image" : "file" };
}

/** The attachment viewer, opened over package items. */
export function PackageMediaViewer({ items, ...props }: WebMediaViewerProps) {
  const attachments: AttachmentRef[] = items.map((item) => ({ id: item.id, name: item.name, size: 0, url: item.url, ...mediaKind(item.mime) }));
  const byId = new Map(items.map((item) => [item.id, item]));
  const { renderOverlay } = props;
  return (
    <AttachmentPreview
      attachments={attachments}
      start={props.start ?? props.index ?? 0}
      index={props.index}
      onIndexChange={props.onIndexChange}
      onClose={props.onClose}
      renderOverlay={renderOverlay ? (attachment, index) => {
        const item = byId.get(attachment.id);
        return item ? renderOverlay(item, index) : null;
      } : undefined}
      aside={props.aside}
      asideLabel={props.asideLabel}
      actions={props.actions}
      gesturesDisabled={props.gesturesDisabled}
      className={props.className}
    />
  );
}

const cast = <K extends keyof Components>(component: unknown) => component as NonNullable<Components[K]>;

export const hostUiComponents = {
  Dialog: cast<"Dialog">(Dialog),
  Switch: cast<"Switch">(Switch),
  Spinner: cast<"Spinner">(Spinner),
  Badge: cast<"Badge">(Badge),
  Notice: cast<"Notice">(Notice),
  Skeleton: cast<"Skeleton">(Skeleton),
  TabPanel: cast<"TabPanel">(TabPanel),
  Icon: cast<"Icon">(Icon),
  Picker: cast<"Picker">(Picker),
  SettingsRow: cast<"SettingsRow">(Row),
  SettingsSection: cast<"SettingsSection">(Section),
  MediaViewer: cast<"MediaViewer">(PackageMediaViewer),
} satisfies Partial<Components>;

export const hostIconSet: WebIconSet = buildIconSet();

export const hostTabIds: NonNullable<HostUi["tabIds"]> = { tab: tabId, panel: tabPanelId };

export const hostConfirm: NonNullable<HostUi["confirm"]> = (message, options) => confirmAlert(message, options ?? {});
