// A chat that belongs to several people from its first message (Spaces
// §14.3): choose who can open it and at what level, and the server applies the
// audience before the chat exists. Its agent therefore knows who reads it from
// the start and never reaches the creator's personal notes — the reason this
// path exists next to sharing an existing chat (§14.6).
import { useEffect, useMemo, useState } from "react";
import {
  type NewChatPeopleDto,
  type SessionAccessLevel,
  type SessionCreationSharing,
  type SessionVisibility,
} from "@polyth/contracts";
import { createSession } from "../init.ts";
import { tr } from "../i18n/index.ts";
import { friendlyError } from "../settings.ts";
import { loadNewChatPeople, personInitials } from "../sessionPeople.ts";
import { accessLabel } from "../sessionSharing.ts";
import {
  Button, CheckIcon, Icon as UiIcon, Notice, ResponsiveOverlay, Select, TextInput,
} from "./ui/index.ts";
import "./ConversationPeople.css";
import "./SharedChatDialog.css";
// The audience choice is the share dialog's own control; reuse its styles
// rather than growing a second look for the same decision.
import "./ShareSessionDialog.css";

interface PersonChoice { userId: string; name: string }

export default function SharedChatDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const [dto, setDto] = useState<NewChatPeopleDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [access, setAccess] = useState<Record<string, SessionAccessLevel>>({});
  const [visibility, setVisibility] = useState<SessionVisibility>("restricted");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected([]);
    setAccess({});
    setVisibility("restricted");
    setTitle("");
    setError(null);
    setLoadError(null);
    setDto(null);
    setLoading(true);
    let live = true;
    void loadNewChatPeople(projectId).then((next) => {
      if (!live) return;
      setDto(next);
      // The default audience is whichever the Space allows.
      setVisibility(next.visibilities.includes("restricted") ? "restricted" : "space");
    }, (cause) => {
      if (live) setLoadError(cause);
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [open, projectId]);

  // Everyone in the Space except the reader, whether or not the project is
  // already open to them: this chat names its people itself.
  const people = useMemo<PersonChoice[]>(() => {
    const rows = [...(dto?.inside ?? []), ...(dto?.people ?? [])];
    const seen = new Set<string>();
    return rows
      .filter((person) => {
        if (seen.has(person.userId)) return false;
        seen.add(person.userId);
        return true;
      })
      .map((person) => ({ userId: person.userId, name: person.name?.trim() || person.userId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [dto]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return people;
    return people.filter((person) => person.name.toLocaleLowerCase().includes(needle)
      || person.userId.toLocaleLowerCase().includes(needle));
  }, [people, query]);
  const levels = useMemo<SessionAccessLevel[]>(() => [...(dto?.levels ?? [])], [dto]);
  const chosenPeople = useMemo(
    () => selected.flatMap((userId) => {
      const person = people.find((candidate) => candidate.userId === userId);
      return person ? [person] : [];
    }),
    [people, selected],
  );
  const accessFor = (userId: string): SessionAccessLevel => {
    const level = access[userId] ?? "collaborate";
    return levels.includes(level) ? level : levels[0] ?? "collaborate";
  };
  const canShare = dto?.action === "share" && dto.visibilities.length > 0;
  const canSubmit = !busy && canShare && (visibility === "space" || selected.length > 0);
  const defaultTitle = chosenPeople.map((person) => person.name).join(", ");

  if (!open) return null;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const sharing: SessionCreationSharing = visibility === "space"
      ? { visibility: "space" }
      : {
        visibility: "restricted",
        grants: selected.map((userId) => ({ userId, access: accessFor(userId) })),
      };
    void createSession(projectId, {
      ...(title.trim() ? { title: title.trim() } : {}),
      sharing,
    }).then(() => {
      onClose();
    }).catch((cause) => {
      setError(cause);
      setBusy(false);
    });
  };

  const toggle = (userId: string) => {
    setSelected((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId]);
  };

  const audiences = (dto?.visibilities ?? []).filter(
    (value): value is "restricted" | "space" => value === "restricted" || value === "space",
  );

  const body = (
    <div className="conversation-create shared-chat-create">
      {loading && <p className="conversation-create-status">{tr("common.loading")}</p>}
      {!loading && loadError !== null && (
        <Notice tone="error" role="alert">{friendlyError(tr("sharing.newSharedChatFailed"), loadError)}</Notice>
      )}
      {!loading && dto && !canShare && (
        <Notice tone="info">{tr("sharing.newSharedChatUnavailable")}</Notice>
      )}
      {!loading && dto && canShare && people.length === 0 && (
        <Notice tone="info">{tr("sharing.newSharedChatNoMembers")}</Notice>
      )}
      {!loading && dto && canShare && people.length > 0 && (
        <>
          <div className="conversation-field">
            <span className="conversation-field-label">{tr("sharing.audience")}</span>
            <div className="shared-chat-audiences" role="radiogroup" aria-label={tr("sharing.audience")}>
              {audiences.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={visibility === value}
                  className="session-sharing-choice"
                  onClick={() => setVisibility(value)}
                >
                  <span className="session-sharing-choice-copy">
                    <span className="session-sharing-choice-label">
                      {tr(value === "space" ? "sharing.space" : "sharing.restricted")}
                    </span>
                    <span className="session-sharing-choice-hint">
                      {tr(value === "space" ? "sharing.spaceHint" : "sharing.restrictedHint")}
                    </span>
                  </span>
                  {visibility === value && <UiIcon icon={CheckIcon} size="sm" className="session-sharing-check" />}
                </button>
              ))}
            </div>
          </div>
          {visibility === "restricted" && (
            <div className="conversation-field">
              <span className="conversation-field-head">
                <span className="conversation-field-label" id="shared-chat-people-label">{tr("conversation.peopleLabel")}</span>
                {selected.length > 0 && (
                  <span className="conversation-field-meta">{tr("conversation.selectedCount", { count: selected.length })}</span>
                )}
              </span>
              {people.length > 6 && (
                <TextInput
                  type="search"
                  value={query}
                  placeholder={tr("conversation.searchPeople")}
                  aria-label={tr("conversation.searchPeople")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              )}
              <ul className="conversation-people" aria-labelledby="shared-chat-people-label">
                {visible.map((person) => {
                  const chosen = selected.includes(person.userId);
                  return (
                    <li key={person.userId}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={chosen}
                        className={`conversation-person${chosen ? " is-selected" : ""}`}
                        onClick={() => toggle(person.userId)}
                      >
                        <span className="person-mark" aria-hidden="true">{personInitials(person.name)}</span>
                        <span className="conversation-person-name" dir="auto">{person.name}</span>
                        <span className="ui-checkbox-box conversation-person-check" aria-hidden="true">
                          {chosen && <UiIcon icon={CheckIcon} size="sm" />}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {visible.length === 0 && <li className="conversation-empty">{tr("conversation.noMatches")}</li>}
              </ul>
            </div>
          )}
          {visibility === "restricted" && chosenPeople.length > 0 && levels.length > 0 && (
            <div className="conversation-field">
              <ul className="conversation-start-people">
                {chosenPeople.map((person) => (
                  <li key={person.userId} className="conversation-start-person">
                    <span className="conversation-start-person-name" dir="auto">{person.name}</span>
                    {levels.length > 1 && (
                      <Select
                        className="conversation-start-person-access"
                        label={tr("sharing.accessFor", { name: person.name })}
                        ariaLabel={tr("sharing.accessFor", { name: person.name })}
                        value={accessFor(person.userId)}
                        options={levels.map((level) => ({ value: level, label: accessLabel(level) }))}
                        onChange={(value) => setAccess((current) => ({ ...current, [person.userId]: value as SessionAccessLevel }))}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="conversation-field">
            <span className="conversation-field-label">{tr("conversation.titleLabel")}</span>
            <TextInput
              value={title}
              placeholder={defaultTitle || tr("sharing.newSharedChat")}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {selected.length === 0 && (
            <p className="conversation-hint">{tr("sharing.newSharedChatHint")}</p>
          )}
          {dto.hasPersonalMcpServers && (
            <p className="conversation-hint">{tr("sharing.personalMcpDetached")}</p>
          )}
        </>
      )}
      {error !== null && <Notice tone="error" role="alert">{friendlyError(tr("sharing.newSharedChatFailed"), error)}</Notice>}
    </div>
  );

  const footer = (
    <>
      <Button onClick={onClose} disabled={busy}>{tr("common.cancel")}</Button>
      <Button variant="primary" onClick={submit} disabled={!canSubmit} busy={busy}>
        {busy ? tr("conversation.creating") : tr("sharing.newSharedChatCreate")}
      </Button>
    </>
  );

  return (
    <ResponsiveOverlay
      open
      title={tr("sharing.newSharedChat")}
      onClose={onClose}
      desktop="dialog"
      phone="sheet"
      dialogSize="md"
      dialogFooter={footer}
      sheetFooter={footer}
      className="shared-chat-dialog"
    >
      {body}
    </ResponsiveOverlay>
  );
}
