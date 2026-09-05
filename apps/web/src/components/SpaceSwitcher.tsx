// Space switcher: the one piece of tenancy that is visible in the shell.
//
// It is deliberately quiet — a text button with a caret that sits beside the
// brand, not a coloured card. Everything it shows is already authorized: the
// server only ever returns Spaces this identity belongs to, so there is no
// client-side filtering here to get wrong.
import { useEffect, useState } from "react";
import { tr } from "../i18n/index.ts";
import {
  activeSpace,
  createSpace,
  deleteSpace,
  loadSpaces,
  renameSpace,
  switchSpace,
  useSpaces,
} from "../spaces.ts";
import { Button, Dialog, Menu, TextInput, type MenuEntry } from "./ui/index.ts";

function ManageSpaces({ onClose }: { onClose: () => void }) {
  const state = useSpaces();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setName("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={tr("spaces.manage")} onClose={onClose} size="sm">
      <ul className="space-manage-list">
        {state.spaces.map((space) => {
          const isActive = space.id === state.activeSpaceId;
          return (
            <li key={space.id} className="space-manage-row">
              <input
                className="space-manage-name"
                defaultValue={space.name}
                aria-label={tr("spaces.renameLabel")}
                disabled={busy || space.role === "viewer" || space.role === "member"}
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next && next !== space.name) void run(() => renameSpace(space.id, next));
                }}
              />
              <span className="space-manage-meta">
                {isActive ? tr("spaces.current") : space.role}
              </span>
              <Button
                variant="ghost"
                size="sm"
                // The default Space is the fallback every device lands in, and
                // the active one still owns this session's context.
                disabled={busy || space.isDefault || isActive || space.role !== "owner"}
                onClick={() => void run(() => deleteSpace(space.id))}
              >
                {tr("common.delete")}
              </Button>
            </li>
          );
        })}
      </ul>
      <form
        className="space-manage-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void run(() => createSpace(name.trim()));
        }}
      >
        <TextInput
          value={name}
          placeholder={tr("spaces.newPlaceholder")}
          aria-label={tr("spaces.newLabel")}
          disabled={busy || !state.canCreate}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !name.trim() || !state.canCreate}>
          {tr("spaces.create")}
        </Button>
      </form>
      {error && <p className="space-manage-error" role="alert">{error}</p>}
    </Dialog>
  );
}

export default function SpaceSwitcher() {
  const state = useSpaces();
  const [managing, setManaging] = useState(false);

  useEffect(() => { void loadSpaces(); }, []);

  // A single Space is the default installation. Showing a switcher with one
  // entry would be noise, so it only appears once there is a choice to make.
  if (state.status !== "ready" || state.spaces.length < 2) {
    return managing ? <ManageSpaces onClose={() => setManaging(false)} /> : null;
  }

  const current = activeSpace(state);
  const entries: MenuEntry[] = [
    ...state.spaces.map((space) => ({
      id: space.id,
      label: space.name,
      kind: "radio" as const,
      checked: space.id === state.activeSpaceId,
      ...(space.color ? { swatch: space.color } : {}),
      disabled: state.switching,
      onSelect: () => { void switchSpace(space.id); },
    })),
    "separator" as const,
    {
      id: "manage",
      label: tr("spaces.manage"),
      onSelect: () => setManaging(true),
    },
  ];

  return (
    <>
      <Menu
        label={tr("spaces.switcherLabel", { name: current?.name ?? "" })}
        title={tr("spaces.title")}
        entries={entries}
        align="start"
      >
        {(trigger) => (
          <button {...trigger} className="space-switcher header-control" disabled={state.switching}>
            <span className="space-switcher-name">{current?.name ?? tr("spaces.title")}</span>
            <svg className="ui-icon ui-icon--sm" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </Menu>
      {managing && <ManageSpaces onClose={() => setManaging(false)} />}
    </>
  );
}
