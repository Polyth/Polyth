// New people-first conversation: choose Space members (never yourself), give
// the conversation an optional title, and write the opening message. Desktop
// presents a dialog; a phone presents the same content as a bottom sheet.
import { useEffect, useMemo, useState } from "react";
import { accountState } from "../accounts.ts";
import { loadCurrentSpaceAccess } from "../spaceAccess.ts";
import {
  conversationOperationId,
  conversationPeople,
  createConversation,
  forgetConversationOperation,
  type SpacePersonChoice,
} from "../conversations.ts";
import {
  conversationOperationKey,
  createConversationPayload,
} from "../conversationModel.ts";
import { openSession } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { tr } from "../i18n/index.ts";
import { Button, Icon as UiIcon, Notice, ResponsiveOverlay, TextInput, Textarea } from "./ui/index.ts";
import { CheckIcon } from "./ui/icons.ts";
import { personInitials } from "../sessionPeople.ts";
import "./ConversationPeople.css";

export default function ConversationCreateDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const [people, setPeople] = useState<SpacePersonChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected([]);
    setTitle("");
    setText("");
    setError(null);
    setLoading(true);
    setLoadError(null);
    let live = true;
    void Promise.all([
      loadCurrentSpaceAccess(),
      accountState().catch(() => null),
    ]).then(([access, accounts]) => {
      if (!live) return;
      const selfId = accounts?.currentAccountId ?? "";
      setPeople(access ? conversationPeople(access.members, accounts?.accounts ?? [], selfId) : []);
    }).catch((cause) => {
      if (live) setLoadError(cause);
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [open, projectId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return people;
    return people.filter((person) => person.name.toLocaleLowerCase().includes(needle)
      || person.userId.toLocaleLowerCase().includes(needle));
  }, [people, query]);
  const selectedPeople = useMemo(
    () => selected.flatMap((userId) => {
      const person = people.find((candidate) => candidate.userId === userId);
      return person ? [person] : [];
    }),
    [people, selected],
  );
  const canSubmit = !busy && selected.length > 0 && text.trim() !== "";

  if (!open) return null;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const operationKey = conversationOperationKey({
      kind: "create",
      projectId,
      participants: selected,
      title,
      text,
    });
    const operationId = conversationOperationId(operationKey);
    void createConversation(createConversationPayload({
      projectId,
      title,
      participants: selected,
      text,
      operationId,
    })).then((result) => {
      forgetConversationOperation(operationKey);
      onClose();
      void openSession(result.id);
    }).catch((cause) => {
      setError(cause);
      setBusy(false);
    });
  };

  const body = (
    <div className="conversation-create">
      {loading && <p className="conversation-create-status">{tr("common.loading")}</p>}
      {!loading && loadError !== null && (
        <Notice tone="error" role="alert">{friendlyError(tr("conversation.peopleFailed"), loadError)}</Notice>
      )}
      {!loading && loadError === null && people.length === 0 && (
        <Notice tone="info">{tr("conversation.noOtherMembers")}</Notice>
      )}
      {people.length > 0 && (
        <div className="conversation-field">
          <span className="conversation-field-head">
            <span className="conversation-field-label" id="conversation-people-label">{tr("conversation.peopleLabel")}</span>
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
          <ul className="conversation-people" aria-labelledby="conversation-people-label">
            {visible.map((person) => {
              const chosen = selected.includes(person.userId);
              return (
                <li key={person.userId}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={chosen}
                    className={`conversation-person${chosen ? " is-selected" : ""}`}
                    onClick={() => setSelected((current) => chosen
                      ? current.filter((id) => id !== person.userId)
                      : [...current, person.userId])}
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
      <label className="conversation-field">
        <span className="conversation-field-label">{tr("conversation.messageLabel")}</span>
        <Textarea
          value={text}
          rows={4}
          placeholder={tr("conversation.messagePlaceholder")}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <label className="conversation-field">
        <span className="conversation-field-label">{tr("conversation.titleLabel")}</span>
        <TextInput
          value={title}
          placeholder={selectedPeople.length > 0
            ? selectedPeople.map((person) => person.name).join(", ")
            : tr("conversation.titlePlaceholder")}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {selected.length === 0 && people.length > 0 && <p className="conversation-hint">{tr("conversation.chooseAtLeastOne")}</p>}
      {error !== null && <Notice tone="error" role="alert">{friendlyError(tr("conversation.createFailed"), error)}</Notice>}
    </div>
  );

  const footer = (
    <>
      <Button onClick={onClose} disabled={busy}>{tr("common.cancel")}</Button>
      <Button variant="primary" onClick={submit} disabled={!canSubmit} busy={busy}>
        {busy ? tr("conversation.creating") : tr("conversation.create")}
      </Button>
    </>
  );

  return (
    <ResponsiveOverlay
      open
      title={tr("conversation.createTitle")}
      onClose={onClose}
      desktop="dialog"
      phone="sheet"
      dialogSize="md"
      dialogFooter={footer}
      sheetFooter={footer}
      className="conversation-create-dialog"
    >
      {body}
    </ResponsiveOverlay>
  );
}
