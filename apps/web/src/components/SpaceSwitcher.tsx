// Space switcher: the one piece of tenancy that is visible in the shell.
//
// It is deliberately quiet — a text button with a caret that sits beside the
// brand, not a coloured card. Everything it shows is already authorized: the
// server only ever returns Spaces this identity belongs to, so there is no
// client-side filtering here to get wrong. The menu (spaceMenu.tsx) is the
// phone Navigator's too; managing Spaces is Settings → Spaces.
import { useEffect } from "react";
import { tr } from "../i18n/index.ts";
import { activeJoinedSpace, activeSpace, loadSpaces, useSpaces } from "../spaces.ts";
import { Menu } from "./ui/index.ts";
import { useSlotVersion } from "./slots/SlotHost.ts";
import { SpaceMark, spaceMenuEntries, spaceTones } from "./spaceMenu.tsx";

export default function SpaceSwitcher() {
  const state = useSpaces();
  // A package adds "Join another server…" after boot: re-read when it does.
  useSlotVersion();

  useEffect(() => { void loadSpaces(); }, []);

  // A single Space is the default installation. Showing a switcher with one
  // entry would be noise, so it only appears once there is a choice to make:
  // another Space here, or one joined on another Polyth server.
  if (state.status !== "ready" || state.spaces.length + state.joined.length < 2) return null;

  const joinedCurrent = activeJoinedSpace(state);
  const current = activeSpace(state) ?? joinedCurrent;
  // Beside another server's Spaces every Space names its server, this
  // server's too when its owner named it: two "Personal"s never look alike.
  const server = joinedCurrent?.serverLabel ?? (state.joined.length ? state.serverName : null);

  return (
    <Menu
      label={tr("spaces.switcherLabel", { name: current?.name ?? "" })}
      title={tr("spaces.title")}
      entries={spaceMenuEntries(state)}
      align="start"
      className="space-menu"
    >
      {(trigger) => (
        <button {...trigger} className="space-switcher header-control" disabled={state.switching}>
          {current && (
            <SpaceMark
              name={current.name}
              tone={spaceTones(state).get(current.id)}
              color={current.color}
              className="space-switcher-mark"
            />
          )}
          <span className="space-switcher-name">{current?.name ?? tr("spaces.title")}</span>
          {server && <span className="space-switcher-server">{server}</span>}
          <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </Menu>
  );
}
