// Settings that take effect only on another kind of screen wait behind one
// closed group per device at the end of their page, so a phone does not list
// desktop window options and a desktop does not list phone gestures. This
// device's settings stay open in their own place above. The others stay one
// click away: appearance can sync across devices, and a window can be resized
// into another shell. Contract: docs/dev/ui.md §4.5 "Settings for other devices".
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import Icon from "../ui/Icon.tsx";
import { ChevronDownIcon } from "../ui/icons.ts";
import { useShellMode, type ShellMode } from "../../responsiveShell.ts";
import { tr, type TranslationKey } from "../../i18n/index.ts";
import { SectionHeadingLevel } from "./parts.tsx";

/** The kind of screen a setting works on, named after the shell it draws:
 *  wide is a desktop window, compact a tablet, phone a phone. */
export type SettingsDevice = "desktop" | "tablet" | "phone";

const DEVICE_OF_SHELL: Record<ShellMode, SettingsDevice> = { wide: "desktop", compact: "tablet", phone: "phone" };
/** Group order, largest screen first. */
const DEVICE_ORDER: readonly SettingsDevice[] = ["desktop", "tablet", "phone"];
const DEVICE_NAMES = {
  desktop: "settings.devices.desktop",
  tablet: "settings.devices.tablet",
  phone: "settings.devices.phone",
} as const satisfies Record<SettingsDevice, TranslationKey>;

/** This screen's device, following the shell as the window crosses a breakpoint. */
export function useSettingsDevice(): SettingsDevice {
  return DEVICE_OF_SHELL[useShellMode()];
}

/** Settings of a page that work on some devices only. */
export interface DeviceBlock {
  /** Devices these settings take effect on. */
  devices: readonly SettingsDevice[];
  /** What the closed group lists for this block. */
  labels: readonly string[];
  /** Settings items inside, so a search hit or deep link opens the group. */
  items: readonly string[];
  /** Whether `render` draws its own `Section`. Loose rows (the default) sit
   *  straight under the group's heading, so the group never repeats the
   *  title of a section still shown on the page. */
  ownSection?: boolean;
  render: () => ReactNode;
}

export function onDevice(block: DeviceBlock, device: SettingsDevice): boolean {
  return block.devices.includes(device);
}

/** The blocks that work on this device, keyed for their place on the page. */
export function blocksOnDevice(blocks: readonly DeviceBlock[], device: SettingsDevice): ReactNode[] {
  return blocks
    .filter((block) => onDevice(block, device))
    .map((block, index) => <Fragment key={index}>{block.render()}</Fragment>);
}

/** Hidden loose rows first, right under the group's heading, then the hidden
 *  sections in page order, one heading level down. */
function groupedForOtherDevices(hidden: readonly DeviceBlock[]): ReactNode {
  const rows = hidden.filter((block) => !block.ownSection);
  const sections = hidden.filter((block) => block.ownSection);
  return (
    <>
      {rows.length > 0 && (
        <div className="settings-section-body settings-other-devices-rows">
          {rows.map((block, index) => <Fragment key={index}>{block.render()}</Fragment>)}
        </div>
      )}
      <SectionHeadingLevel.Provider value={4}>
        {sections.map((block, index) => <Fragment key={index}>{block.render()}</Fragment>)}
      </SectionHeadingLevel.Provider>
    </>
  );
}

/** The page's closing groups of settings for other devices: one per device,
 *  largest screen first. A block that works on several hidden devices sits in
 *  each of their groups, so every group is that device's whole list. Renders
 *  nothing when every block works here. Each group is closed on every visit,
 *  unless the page was opened on one of its settings; a setting found in two
 *  groups opens the first. A page that points at a setting again (a second
 *  click on the same preview part) bumps `revision` to reopen its group. */
export function OtherDevicesSection({ device, blocks, target, revision = 0 }: {
  device: SettingsDevice;
  blocks: readonly DeviceBlock[];
  target?: string | undefined;
  revision?: number;
}) {
  const hidden = blocks.filter((block) => !onDevice(block, device));
  const groups = DEVICE_ORDER
    .filter((other) => other !== device)
    .map((other) => ({ other, blocks: hidden.filter((block) => onDevice(block, other)) }))
    .filter((group) => group.blocks.length > 0);
  const targetGroup = target
    ? groups.find((group) => group.blocks.some((block) => block.items.includes(target)))?.other
    : undefined;
  return (
    <>
      {groups.map((group) => (
        <OtherDeviceGroup
          key={group.other}
          device={group.other}
          blocks={group.blocks}
          targeted={group.other === targetGroup}
          target={target}
          revision={revision}
        />
      ))}
    </>
  );
}

/** One other device's closed group: its name, the labels it holds, and on a
 *  press its settings. */
function OtherDeviceGroup({ device, blocks, targeted, target, revision }: {
  device: SettingsDevice;
  blocks: readonly DeviceBlock[];
  targeted: boolean;
  target?: string | undefined;
  revision: number;
}) {
  const [open, setOpen] = useState(targeted);
  // Only a press animates: a group opened for a search hit lands settled.
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (targeted) setOpen(true);
  }, [targeted, target, revision]);
  const titleId = useId();
  const bodyId = useId();
  return (
    <section
      className="settings-section settings-other-devices"
      aria-labelledby={titleId}
      data-device={device}
      data-open={open ? "true" : undefined}
    >
      <h3 className="settings-other-devices-heading">
        <button
          type="button"
          className="settings-other-devices-toggle"
          aria-expanded={open}
          {...(open ? { "aria-controls": bodyId } : {})}
          onClick={() => { setPressed(true); setOpen(!open); }}
        >
          {/* The chevron follows the title, as on the page's other folds, so
              a wide pane does not leave it a window's width away. */}
          <span className="settings-other-devices-title-line">
            <span className="settings-section-title" id={titleId}>{tr("settings.devices.title", { devices: tr(DEVICE_NAMES[device]) })}</span>
            <span className="settings-other-devices-chevron" aria-hidden="true"><Icon icon={ChevronDownIcon} size="sm" /></span>
          </span>
          {/* What a closed group holds; open, its settings say it. A narrow
              screen wraps between labels, never inside one. */}
          {!open && (
            <span className="settings-section-hint">
              {blocks.flatMap((block) => block.labels).map((label, index) => (
                <Fragment key={index}>{index > 0 && " · "}<span className="settings-other-devices-label">{label}</span></Fragment>
              ))}
            </span>
          )}
        </button>
      </h3>
      {open && (
        <div id={bodyId} className="settings-other-devices-body" data-motion={pressed ? "opening" : undefined}>
          {groupedForOtherDevices(blocks)}
        </div>
      )}
    </section>
  );
}
