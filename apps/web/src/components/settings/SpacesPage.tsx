// Settings → Spaces: the Spaces this person can open, in one place.
//
// This server's Spaces are listed, opened, created, renamed and deleted here.
// Below them, other packages add sections through `settings.spaces.sections`:
// Polyth Link shows the other servers joined, and joining one, so the Space
// menu's "Manage spaces…" and "Join another server…" both land on this page.
//
// Renaming and deleting ask first (a name prompt; a destructive confirmation
// that says what goes), and every refusal says why instead of hiding a
// disabled button. The server still decides: it refuses deleting the default
// Space or the one in use, and anything a role does not allow.
import { useEffect, useState } from "react";
import type { SpaceSummaryDto } from "@polyth/contracts";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import { tr } from "../../i18n/index.ts";
import { confirmAlert, promptAlert } from "../../alerts.ts";
import { deleteSpace, loadSpaces, renameSpace, switchSpace, useSpaces } from "../../spaces.ts";
import {
  Badge,
  Button,
  DeleteIcon,
  EditIcon,
  IconButton,
  Menu,
  MoreIcon,
  PlusIcon,
  Spinner,
  type MenuEntry,
} from "../ui/index.ts";
import SlotHost from "../slots/SlotHost.ts";
import { ErrorState, Section } from "./parts.tsx";
import { roleText } from "./usersModel.ts";
import { SPACES_SECTIONS_SLOT, SpaceMark, createSpaceFromPrompt, spaceTones } from "../spaceMenu.tsx";

const mayRename = (space: SpaceSummaryDto): boolean => space.role === "owner" || space.role === "admin";

export default function SpacesPage({ settingsTarget }: { settingsTarget?: SettingsNavigationTarget }) {
  const state = useSpaces();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ title: string; text: string } | null>(null);

  useEffect(() => { void loadSpaces(); }, []);

  const run = async (spaceId: string, title: string, action: () => Promise<void>) => {
    setBusy(spaceId);
    setFailure(null);
    try {
      await action();
    } catch (cause) {
      setFailure({ title, text: (cause as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const rename = async (space: SpaceSummaryDto) => {
    const next = (await promptAlert(tr("spaces.renamePrompt", { name: space.name }), {
      title: tr("spaces.renameTitle"),
      confirmLabel: tr("common.save"),
      placeholder: tr("spaces.namePlaceholder"),
      initialValue: space.name,
    }))?.trim();
    if (!next || next === space.name) return;
    await run(space.id, tr("spaces.renameFailed"), () => renameSpace(space.id, next));
  };

  const remove = async (space: SpaceSummaryDto, origin?: DOMRect) => {
    const confirmed = await confirmAlert(tr("spaces.deleteConfirm"), {
      title: tr("spaces.deleteTitle", { name: space.name }),
      confirmLabel: tr("common.delete"),
      destructive: true,
      ...(origin ? { origin } : {}),
    });
    if (confirmed) await run(space.id, tr("spaces.deleteFailed"), () => deleteSpace(space.id));
  };

  /** Why this Space cannot be deleted now, or null when it can. */
  const deleteBlocked = (space: SpaceSummaryDto): string | null => {
    if (space.role !== "owner") return tr("spaces.deleteOwnerOnly");
    if (space.isDefault) return tr("spaces.deleteDefault");
    if (space.id === state.activeSpaceId) return tr("spaces.deleteCurrent");
    return null;
  };

  const rowMenu = (space: SpaceSummaryDto): MenuEntry[] => {
    if (!mayRename(space)) return [];
    const blocked = deleteBlocked(space);
    return [
      { id: "rename", label: tr("spaces.rename"), icon: EditIcon, onSelect: () => { void rename(space); } },
      {
        id: "delete",
        label: tr("spaces.delete"),
        icon: DeleteIcon,
        danger: true,
        disabled: blocked !== null,
        ...(blocked ? { detail: blocked } : {}),
        onSelect: (context) => { void remove(space, context?.origin); },
      },
    ];
  };

  const tones = spaceTones(state);
  const ready = state.status === "ready";

  return (
    <div className="spaces-page">
      <Section
        // Named like the menu heads it: the owner's name for this server and
        // "This server" beside it, so it never reads as another server.
        title={state.serverName ? (
          <span className="spaces-page-server">
            {state.serverName}
            <Badge>{tr("spaces.thisServer")}</Badge>
          </span>
        ) : tr("spaces.thisServer")}
        hint={tr("spaces.pageHint")}
        itemId="spaces.local"
        action={ready && state.canCreate ? (
          <Button size="sm" iconStart={PlusIcon} onClick={() => void createSpaceFromPrompt({ open: false })}>
            {tr("spaces.newTitle")}
          </Button>
        ) : undefined}
      >
        {state.status === "error" && state.spaces.length === 0 ? (
          <ErrorState compact error={state.error ?? ""} onRetry={() => void loadSpaces()} />
        ) : !ready ? (
          <Spinner />
        ) : (
          <ul className="users-list spaces-list">
            {state.spaces.map((space) => {
              const current = space.id === state.activeSpaceId;
              const entries = rowMenu(space);
              const meta = [
                roleText(space.role).label,
                space.memberCount > 1 ? tr("spaces.members", { count: space.memberCount }) : null,
              ].filter(Boolean).join(" · ");
              return (
                <li key={space.id}>
                  <div className="user-row space-row" aria-busy={busy === space.id || undefined}>
                    <SpaceMark name={space.name} tone={tones.get(space.id)} color={space.color} className="is-row" />
                    <span className="user-row-copy">
                      <span className="user-row-name">
                        <strong dir="auto">{space.name}</strong>
                        {current && <Badge tone="accent">{tr("spaces.current")}</Badge>}
                      </span>
                      <span className="user-row-meta">{meta}</span>
                    </span>
                    {!current && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={state.switching || busy !== null}
                        onClick={() => void switchSpace(space.id)}
                      >
                        {tr("spaces.open")}
                      </Button>
                    )}
                    {entries.length > 0 && (
                      <Menu label={tr("spaces.more", { name: space.name })} align="end" entries={entries}>
                        {(trigger) => (
                          <IconButton
                            {...trigger}
                            icon={MoreIcon}
                            size="sm"
                            label={tr("spaces.more", { name: space.name })}
                            disabled={busy !== null}
                          />
                        )}
                      </Menu>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {failure && <ErrorState compact title={failure.title} error={failure.text} />}
      </Section>
      <SlotHost slot={SPACES_SECTIONS_SLOT} placed={false} context={settingsTarget ? { settingsTarget } : {}} />
    </div>
  );
}
