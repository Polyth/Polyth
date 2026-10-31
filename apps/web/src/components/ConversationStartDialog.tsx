// Start an agent session from selected person messages. The participant list
// is a one-time copy of the conversation's current grants: remove people or
// change their access here without changing the conversation itself.
import { useEffect, useMemo, useState } from "react";
import { SESSION_ACCESS_LEVELS, type ModelRef, type SessionAccessLevel } from "@polyth/contracts";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { useStore } from "../store.ts";
import { useSpaces } from "../spaces.ts";
import { loadSessionSharing, accessLabel } from "../sessionSharing.ts";
import {
  conversationOperationId,
  forgetConversationOperation,
  startSessionFromConversation,
} from "../conversations.ts";
import {
  conversationOperationKey,
  participantsFromGrants,
  startSessionPayload,
  type ConversationParticipantDraft,
} from "../conversationModel.ts";
import { activeBrowserAccountId } from "../accountStorage.ts";
import { openSession } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { tr } from "../i18n/index.ts";
import { Button, IconButton, Notice, ResponsiveOverlay, Select, TextInput, Textarea } from "./ui/index.ts";
import { CloseIcon } from "./ui/icons.ts";
import { personInitials } from "../sessionPeople.ts";
import "./ConversationPeople.css";

export default function ConversationStartDialog({
  open,
  sessionId,
  sourceSeqs,
  defaultTitle,
  sources = [],
  onClose,
  onStarted,
}: {
  open: boolean;
  sessionId: string;
  sourceSeqs: readonly number[];
  defaultTitle: string;
  /** The chosen messages, in order, so the person sees what the agent gets. */
  sources?: ReadonlyArray<{ seq: number; author: string; text: string }>;
  onClose: () => void;
  /** The session exists; the caller leaves its selection mode. */
  onStarted?: () => void;
}) {
  const projectId = useStore((state) => state.sessions.find((row) => row.id === sessionId)?.projectId ?? undefined);
  const storeModels = useStore((state) => state.models);
  const storeAgents = useStore((state) => state.agents);
  const spaceId = useSpaces().activeSpaceId ?? undefined;
  // The new chat runs on the project's route unless the person picks a model.
  const catalog = useRuntimeCatalog(null, storeModels, storeAgents, { ...(projectId ? { projectId } : {}), ...(spaceId ? { spaceId } : {}) });
  const [model, setModel] = useState<(ModelRef & { harnessId?: string }) | undefined>(undefined);
  const [participants, setParticipants] = useState<ConversationParticipantDraft[]>([]);
  const [title, setTitle] = useState(defaultTitle);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle);
    setPrompt("");
    setModel(undefined);
    setError(null);
    setLoadError(null);
    setLoading(true);
    setParticipants([]);
    let live = true;
    const selfId = activeBrowserAccountId() ?? "";
    void loadSessionSharing(sessionId).then((sharing) => {
      if (live) setParticipants(participantsFromGrants(sharing.grants, selfId));
    }).catch((cause) => {
      if (live) setLoadError(cause);
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [open, sessionId, defaultTitle]);

  const accessOptions = useMemo(
    () => SESSION_ACCESS_LEVELS.map((level) => ({ value: level, label: accessLabel(level) })),
    [],
  );
  // Nobody left to share with simply keeps the new chat private.
  const canSubmit = !busy && !loading;

  if (!open) return null;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const operationKey = conversationOperationKey({
      kind: "start",
      sessionId,
      participants,
      title,
      text: prompt,
      sourceSeqs,
    });
    const operationId = conversationOperationId(operationKey);
    const harnessId = model?.harnessId ?? catalog.harnessId;
    void startSessionFromConversation(sessionId, {
      ...startSessionPayload({ sourceSeqs, title, prompt, participants, operationId }),
      ...(model ? {
        model: { providerID: model.providerID, modelID: model.modelID, ...(model.variant ? { variant: model.variant } : {}) },
        ...(harnessId ? { harness: { mode: "pinned" as const, harnessId } } : {}),
      } : {}),
    }).then((result) => {
      forgetConversationOperation(operationKey);
      onStarted?.();
      onClose();
      void openSession(result.sessionId);
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
      {sources.length > 0 && (
        <section className="conversation-start-sources" aria-label={tr("conversation.startSources")}>
          {sources.map((source) => (
            <blockquote className="conversation-start-source" key={source.seq}>
              <span className="conversation-start-source-author" dir="auto">{source.author}</span>
              <span className="conversation-start-source-text" dir="auto">{source.text}</span>
            </blockquote>
          ))}
        </section>
      )}
      <label className="conversation-field">
        <span className="conversation-field-label">{tr("conversation.startInstruction")}</span>
        <Textarea
          value={prompt}
          rows={3}
          placeholder={tr("conversation.startInstructionPlaceholder")}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <label className="conversation-field">
        <span className="conversation-field-label">{tr("conversation.titleLabel")}</span>
        <TextInput value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="conversation-field">
        <span className="conversation-field-label">{tr("conversation.startModel")}</span>
        <ModelPicker
          className="conversation-start-model"
          models={catalog.models}
          {...(catalog.harnessId ? { harnessId: catalog.harnessId } : {})}
          {...(model ? { value: model } : {})}
          catalogLoading={!catalog.ready}
          emptyLabel={tr("conversation.startModelDefault")}
          onPick={setModel}
        />
      </div>
      <div className="conversation-field">
        <span className="conversation-field-label">{tr("conversation.startPeople")}</span>
        {!loading && participants.length === 0 && (
          <p className="conversation-start-empty">{tr("conversation.noParticipants")}</p>
        )}
        <ul className="conversation-start-people">
          {participants.map((participant) => (
            <li className="conversation-start-person" key={participant.userId}>
              <span className="person-mark" aria-hidden="true">{personInitials(participant.name || participant.userId)}</span>
              <span className="conversation-start-person-name" dir="auto">
                {participant.name || participant.userId}
              </span>
              <Select
                className="conversation-start-person-access"
                label={tr("conversation.accessFor", { name: participant.name || participant.userId })}
                value={participant.access}
                options={accessOptions}
                searchable={false}
                onChange={(access) => {
                  setParticipants((current) => current.map((row) =>
                    row.userId === participant.userId ? { ...row, access: access as SessionAccessLevel } : row));
                }}
              />
              <IconButton
                className="conversation-start-remove"
                size="sm"
                variant="quiet"
                icon={CloseIcon}
                label={tr("conversation.removePerson", { name: participant.name || participant.userId })}
                onClick={() => setParticipants((current) =>
                  current.filter((row) => row.userId !== participant.userId))}
              />
            </li>
          ))}
        </ul>
      </div>
      {error !== null && <Notice tone="error" role="alert">{friendlyError(tr("conversation.startFailed"), error)}</Notice>}
    </div>
  );

  const footer = (
    <>
      <Button onClick={onClose} disabled={busy}>{tr("common.cancel")}</Button>
      <Button variant="primary" onClick={submit} disabled={!canSubmit} busy={busy}>
        {busy ? tr("conversation.starting") : tr("conversation.start")}
      </Button>
    </>
  );

  return (
    <ResponsiveOverlay
      open
      title={tr("conversation.startTitle")}
      onClose={onClose}
      desktop="dialog"
      phone="sheet"
      dialogSize="md"
      dialogFooter={<div className="conversation-start-dialog-foot">{footer}</div>}
      sheetFooter={<div className="conversation-start-dialog-foot">{footer}</div>}
      className="conversation-start-dialog"
    >
      {body}
    </ResponsiveOverlay>
  );
}
