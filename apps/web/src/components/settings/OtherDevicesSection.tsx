// Settings that take effect only on another kind of screen wait behind one
// closed group at the end of their page, so a phone does not list desktop
// window options and a desktop does not list phone gestures. They stay one
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
/** Title order: the two devices a page can hide read best desktop/phone first. */
const DEVICE_ORDER: readonly SettingsDevice[] = ["desktop", "phone", "tablet"];
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

/** The page's closing group of settings for other devices. Renders nothing
 *  when every block works here. Closed on every visit, unless the page was
 *  opened on one of its settings. */
export function OtherDevicesSection({ device, blocks, target }: {
  device: SettingsDevice;
  blocks: readonly DeviceBlock[];
  target?: string | undefined;
}) {
  const hidden = blocks.filter((block) => !onDevice(block, device));
  const targeted = !!target && hidden.some((block) => block.items.includes(target));
  const [open, setOpen] = useState(targeted);
  // Only a press animates: a group opened for a search hit lands settled.
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (targeted) setOpen(true);
  }, [targeted, target]);
  const titleId = useId();
  const bodyId = useId();
  if (hidden.length === 0) return null;
  const names = DEVICE_ORDER
    .filter((other) => other !== device && hidden.some((block) => block.devices.includes(other)))
    .map((other) => tr(DEVICE_NAMES[other]));
  const devices = names.length > 1
    ? tr("settings.devices.pair", { first: names[0]!, second: names[1]! })
    : names[0] ?? "";
  return (
    <section
      className="settings-section settings-other-devices"
      aria-labelledby={titleId}
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
          <span className="settings-section-copy">
            <span className="settings-section-title" id={titleId}>{tr("settings.devices.title", { devices })}</span>
            {/* A narrow screen wraps between labels, never inside one. */}
            <span className="settings-section-hint">
              {hidden.flatMap((block) => block.labels).map((label, index) => (
                <Fragment key={index}>{index > 0 && " · "}<span className="settings-other-devices-label">{label}</span></Fragment>
              ))}
            </span>
          </span>
          <span className="settings-other-devices-chevron" aria-hidden="true"><Icon icon={ChevronDownIcon} size="sm" /></span>
        </button>
      </h3>
      {open && (
        <div id={bodyId} className="settings-other-devices-body" data-motion={pressed ? "opening" : undefined}>
          <p className="settings-other-devices-note">{tr("settings.devices.note")}</p>
          {groupedForOtherDevices(hidden)}
        </div>
      )}
    </section>
  );
}
