// The Space menu, shared by the header switcher (SpaceSwitcher.tsx) and the
// phone Navigator (MobileNavigator.tsx), and the Space mark both draw.
//
// Every Polyth server names its first Space "Personal", so a Space's name
// alone never tells this server's from one joined on another server. Once a
// person has joined another server, the menu groups Spaces under the server
// they live on: this server's under the name its owner chose (else "This
// server"), each other server's under its own name and, while unreachable,
// "Offline". The actions sit under a separator with their own glyphs, so they
// never read as one more Space.
import type { CSSProperties, ReactNode } from "react";
import type { JoinedSpaceDto, SpaceSummaryDto } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { confirmAlert, promptAlert } from "../alerts.ts";
import { assignPersonTones } from "../personIdentity.ts";
import { listSlots } from "../slots.ts";
import { openSettingsPage } from "../store.ts";
import { createSpace, getSpacesState, switchSpace, type SpacesState } from "../spaces.ts";
import { LinkIcon, PlusIcon, SettingsIcon, type MenuEntry } from "./ui/index.ts";

/** Settings → Spaces (SpacesPage.tsx). */
export const SPACES_SETTINGS_PAGE = "spaces";

/** Sections other packages add to Settings → Spaces. A contribution whose
 *  `meta.joinsServers` is true handles the page's `join` target, and the
 *  menus then offer "Join another server…". */
export const SPACES_SECTIONS_SLOT = "settings.spaces.sections";

type AnySpace = SpaceSummaryDto | JoinedSpaceDto;

/** One server's Spaces, as the menu and the Spaces page group them. */
export interface SpaceServerGroup {
  /** "local" for this server, else the Link connection id. */
  key: string;
  label: string;
  local: boolean;
  online: boolean;
  spaces: AnySpace[];
}

/** This server's Spaces first, then each joined server's, in the order the
 *  server lists them. */
export function spaceServerGroups(state: Pick<SpacesState, "spaces" | "joined" | "serverName">): SpaceServerGroup[] {
  const groups: SpaceServerGroup[] = [{
    key: "local",
    label: state.serverName ?? tr("spaces.thisServer"),
    local: true,
    online: true,
    spaces: state.spaces,
  }];
  const byConnection = new Map<string, SpaceServerGroup>();
  for (const space of state.joined) {
    let group = byConnection.get(space.connectionId);
    if (!group) {
      group = { key: space.connectionId, label: space.serverLabel, local: false, online: space.online, spaces: [] };
      byConnection.set(space.connectionId, group);
      groups.push(group);
    }
    group.spaces.push(space);
  }
  return groups;
}

/** Distinct tones for every Space the person can open, here and elsewhere. */
export const spaceTones = (state: Pick<SpacesState, "spaces" | "joined">): Map<string, number> =>
  assignPersonTones([...state.spaces, ...state.joined].map((space) => space.id));

/** A Space's monogram: its first letter on its tone, or on its own colour. */
export function SpaceMark({ name, tone, color, className }: {
  name: string;
  tone: number | undefined;
  color?: string | undefined;
  className?: string | undefined;
}): ReactNode {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
  return (
    <span
      className={`space-mark${className ? ` ${className}` : ""}`}
      data-person-tone={tone}
      style={color ? { "--space-mark-fill": color } as CSSProperties : undefined}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

/** The mark in a menu row's icon column, sized like the row's glyphs. */
const markIcon = (space: AnySpace, tone: number | undefined) =>
  (props?: { className?: string }) => <SpaceMark name={space.name} tone={tone} color={space.color} className={props?.className} />;

/** Whether a package offers joining another server on the Spaces page. */
export function canJoinServers(): boolean {
  return listSlots(SPACES_SECTIONS_SLOT).some((item) => item.meta?.joinsServers === true);
}

/**
 * Ask for a name and create a Space. `open` switches into it, as the menu's
 * "New space…" does; the Spaces page stays where it is.
 */
export async function createSpaceFromPrompt({ open }: { open: boolean }): Promise<void> {
  const name = (await promptAlert(tr("spaces.newPrompt"), {
    title: tr("spaces.newTitle"),
    confirmLabel: tr("spaces.create"),
    placeholder: tr("spaces.namePlaceholder"),
  }))?.trim();
  if (!name) return;
  const before = new Set(getSpacesState().spaces.map((space) => space.id));
  try {
    await createSpace(name);
  } catch (cause) {
    await confirmAlert((cause as Error).message, {
      title: tr("spaces.createFailed"),
      confirmLabel: tr("common.close"),
      destructive: false,
    });
    return;
  }
  const created = getSpacesState().spaces.find((space) => !before.has(space.id));
  if (open && created) await switchSpace(created.id);
}

/**
 * The menu's entries: the Spaces (grouped by server once there is more than
 * one), then a separator and the actions. `extra` actions (the phone's
 * "Switch server") join the actions group.
 */
export function spaceMenuEntries(state: SpacesState, extra: readonly MenuEntry[] = []): MenuEntry[] {
  const tones = spaceTones(state);
  const row = (space: AnySpace): MenuEntry => ({
    id: `space:${space.id}`,
    label: space.name,
    kind: "radio",
    checked: space.id === state.activeSpaceId,
    icon: markIcon(space, tones.get(space.id)),
    disabled: state.switching,
    onSelect: () => { void switchSpace(space.id); },
  });
  const groups = spaceServerGroups(state);
  const spaces: MenuEntry[] = groups.length > 1
    ? groups.flatMap((group): MenuEntry[] => {
      const detail = group.local
        ? state.serverName ? tr("spaces.thisServer") : undefined
        : group.online ? undefined : tr("spaces.offline");
      return [{ heading: group.label, ...(detail ? { detail } : {}) }, ...group.spaces.map(row)];
    })
    : state.spaces.map(row);
  const actions: MenuEntry[] = [
    ...(state.canCreate ? [{
      id: "spaces:new",
      label: tr("spaces.newSpace"),
      icon: PlusIcon,
      onSelect: () => { void createSpaceFromPrompt({ open: true }); },
    }] : []),
    {
      id: "spaces:manage",
      label: tr("spaces.manage"),
      icon: SettingsIcon,
      onSelect: () => openSettingsPage(SPACES_SETTINGS_PAGE),
    },
    ...(canJoinServers() ? [{
      id: "spaces:join",
      label: tr("spaces.join"),
      icon: LinkIcon,
      onSelect: () => openSettingsPage(SPACES_SETTINGS_PAGE, { sectionId: "join" }),
    }] : []),
    ...extra,
  ];
  return [...spaces, "separator", ...actions];
}
