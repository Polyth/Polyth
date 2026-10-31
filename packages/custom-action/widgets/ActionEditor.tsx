// Create or edit one action: its look, its command, what a press does, and
// where it is offered. A dialog on desktop, a tall sheet on phone; nothing is
// saved until Save, and leaving with changes asks first.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { isImeComposing } from "@polyth/web-sdk";
import ProjectGlyph from "../../../apps/web/src/components/ProjectGlyph.tsx";
import {
  Button,
  confirmAlert,
  DeleteIcon,
  EditIcon,
  GlobeIcon,
  Icon,
  MonitoringIcon,
  NewChatIcon,
  ResponsiveOverlay,
  TerminalIcon,
  Textarea,
  Switch,
  TextInput,
  type LucideIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  ActionInputError,
  ACTION_LIMITS,
  normalizeActionInput,
  OUTPUT_PLACEHOLDER,
  type ActionChatWhen,
  type ActionColor,
  type ActionIconId,
  type ActionModelRef,
  type ActionRunMode,
  type CustomActionDto,
  type CustomActionInput,
} from "../src/index.ts";
import ActionGlyph from "./ActionGlyph.tsx";
import ChatTarget from "./ChatTarget.tsx";
import IconPicker from "./IconPicker.tsx";
import { deleteAction, saveAction, useActions } from "./store.ts";
import { actionHost } from "./host.ts";
import { announceCreated, railState, setOnRail } from "./railLaunchers.tsx";

interface Draft {
  name: string;
  icon: ActionIconId;
  color: ActionColor;
  command: string;
  mode: ActionRunMode;
  scope: "project" | "global";
  harnessId?: string;
  model?: ActionModelRef;
  prompt: string;
  when: ActionChatWhen;
  /** Ask before every run. */
  confirm: boolean;
  confirmMessage: string;
  /** Show the action's launcher on the right rail of the open project. */
  onRail: boolean;
}

const MODES: ReadonlyArray<{ id: ActionRunMode; icon: LucideIcon; title: Parameters<typeof tr>[0]; body: Parameters<typeof tr>[0] }> = [
  { id: "background", icon: MonitoringIcon, title: "customaction.mode.background", body: "customaction.mode.backgroundHint" },
  { id: "terminal", icon: TerminalIcon, title: "customaction.mode.terminal", body: "customaction.mode.terminalHint" },
  { id: "chat", icon: NewChatIcon, title: "customaction.mode.chat", body: "customaction.mode.chatHint" },
];

const WHEN: ReadonlyArray<[ActionChatWhen, Parameters<typeof tr>[0]]> = [
  ["always", "customaction.when.always"],
  ["failure", "customaction.when.failure"],
  ["success", "customaction.when.success"],
];

function draftFrom(action: Partial<CustomActionInput> | null | undefined, projectId: string | null, onRail: boolean): Draft {
  return {
    name: action?.name ?? "",
    icon: action?.icon ?? "zap",
    color: action?.color ?? "accent",
    command: action?.command ?? "",
    mode: action?.mode ?? "background",
    scope: action?.projectId === null || (!action?.projectId && !projectId) ? "global" : "project",
    ...(action?.chat?.harnessId ? { harnessId: action.chat.harnessId } : {}),
    ...(action?.chat?.model ? { model: action.chat.model } : {}),
    prompt: action?.chat?.prompt ?? "",
    when: action?.chat?.when ?? "always",
    confirm: !!action?.confirm,
    confirmMessage: action?.confirm?.message ?? "",
    onRail,
  };
}

/** A name for an unnamed action: the command's first words. */
export const suggestedName = (command: string): string => {
  const first = command.trim().split("\n")[0]!.replace(/\s+/g, " ").trim();
  return first.length > 40 ? `${first.slice(0, 39).trimEnd()}…` : first;
};

function inputFrom(draft: Draft, projectId: string | null): CustomActionInput {
  return normalizeActionInput({
    name: draft.name.trim() || suggestedName(draft.command),
    icon: draft.icon,
    color: draft.color,
    command: draft.command,
    mode: draft.mode,
    projectId: draft.scope === "project" ? projectId : null,
    chat: {
      ...(draft.harnessId ? { harnessId: draft.harnessId } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      prompt: draft.prompt,
      when: draft.when,
    },
    ...(draft.confirm ? { confirm: { message: draft.confirmMessage } } : {}),
  });
}

function Field({ label, hint, error, htmlFor, children, aside }: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  htmlFor?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="ca-field" data-invalid={error ? true : undefined}>
      <div className="ca-field-head">
        {htmlFor ? <label className="ca-field-label" htmlFor={htmlFor}>{label}</label> : <span className="ca-field-label">{label}</span>}
        {aside}
      </div>
      {children}
      {error ? <p className="ca-field-error" role="alert">{error}</p> : hint ? <p className="ca-field-hint">{hint}</p> : null}
    </div>
  );
}

export default function ActionEditor({
  open,
  action,
  seed,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The action being edited; omit to create one. */
  action?: CustomActionDto | null;
  /** Starting values for a new action (a template or a duplicate). */
  seed?: Partial<CustomActionInput> | null;
  /** The project "This project" means here. */
  projectId: string | null;
  onClose: () => void;
  onSaved?: (action: CustomActionDto) => void;
}) {
  const snapshot = useActions();
  const projects = useStore((state) => state.projectRegistry.projects);
  // An existing project action keeps its own project, wherever it is edited.
  const ownerProjectId = action ? action.projectId ?? projectId : projectId;
  const project = projects.find((item) => item.id === ownerProjectId) ?? null;
  const activeProjectId = useStore((state) => state.activeProjectId);
  const host = actionHost();
  const canPlace = !!host?.capabilities?.place;
  // Creating a shortcut should make it reachable, so a new action starts on the
  // rail; an existing one reflects where it is now.
  const initial = useMemo(
    () => draftFrom(action ?? seed ?? null, ownerProjectId, action ? !!host && railState(host, action.id) === true : true),
    [action, seed, ownerProjectId, host, open],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [iconOpen, setIconOpen] = useState(false);
  const iconButton = useRef<HTMLButtonElement>(null);
  const ids = useId();

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setErrors({});
    setFailure(null);
    setSaving(false);
  }, [open, initial]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (errors[key] || (key === "harnessId" && errors["chat.harnessId"]) || (key === "confirmMessage" && errors["confirm.message"])) setErrors({});
  };

  const close = async () => {
    if (saving) return;
    if (dirty && !(await confirmAlert(tr("customaction.editor.discardBody"), {
      title: tr("customaction.editor.discardTitle"),
      confirmLabel: tr("customaction.editor.discard"),
      destructive: true,
    }))) return;
    onClose();
  };

  const save = async () => {
    if (saving) return;
    let input: CustomActionInput;
    try {
      if (draft.scope === "project" && !ownerProjectId) {
        setErrors({ projectId: tr("customaction.editor.chooseProject") });
        return;
      }
      input = inputFrom(draft, ownerProjectId);
    } catch (cause) {
      if (cause instanceof ActionInputError) {
        setErrors({ [cause.field]: cause.message });
        return;
      }
      throw cause;
    }
    setSaving(true);
    setFailure(null);
    try {
      const saved = await saveAction(input, action?.id);
      if (host && canPlace && appliesHere && (!action || draft.onRail !== initial.onRail)) setOnRail(host, saved.id, draft.onRail);
      if (host && !action) announceCreated(host, saved, { placed: canPlace && appliesHere && draft.onRail, canPlace: canPlace && appliesHere });
      onSaved?.(saved);
      onClose();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!action) return;
    const confirmed = await confirmAlert(tr("customaction.editor.deleteBody", { name: action.name }), {
      title: tr("customaction.editor.deleteTitle"),
      confirmLabel: tr("customaction.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await deleteAction(action.id);
      onClose();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  const footer = (
    <div className="ca-editor-foot">
      {action && snapshot.canManage && (
        <Button variant="ghost" size="sm" className="ca-editor-delete" iconStart={DeleteIcon} disabled={saving} onClick={() => void remove()}>
          {tr("customaction.delete")}
        </Button>
      )}
      <span className="ca-editor-foot-spacer" />
      <Button variant="quiet" disabled={saving} onClick={() => void close()}>{tr("customaction.cancel")}</Button>
      <Button variant="primary" busy={saving} disabled={!draft.command.trim() || !snapshot.canManage} onClick={() => void save()}>
        {action ? tr("customaction.save") : tr("customaction.editor.create")}
      </Button>
    </div>
  );

  // The rail is the open project's layout: offered only where this action applies.
  const appliesHere = !!activeProjectId && (draft.scope === "global" || ownerProjectId === activeProjectId);

  const placeholderName = suggestedName(draft.command) || tr("customaction.editor.namePlaceholder");

  return (
    <ResponsiveOverlay
      open={open}
      onClose={() => void close()}
      title={action ? tr("customaction.editor.editTitle") : tr("customaction.editor.newTitle")}
      desktop="dialog"
      phone="sheet"
      sheetSize="tall"
      dialogSize="md"
      className="ca-editor-surface"
      dialogFooter={footer}
      sheetFooter={footer}
      initialFocus={action ? ".ca-name-input" : ".ca-command-input"}
    >
      <div className="ca-editor" onKeyDown={onKeyDown}>
        <div className="ca-identity">
          <button
            ref={iconButton}
            type="button"
            className="ca-identity-glyph"
            aria-haspopup="dialog"
            aria-expanded={iconOpen}
            aria-label={tr("customaction.editor.changeIcon")}
            title={tr("customaction.editor.changeIcon")}
            onClick={() => setIconOpen((value) => !value)}
          >
            <ActionGlyph icon={draft.icon} color={draft.color} size="xl" />
            <span className="ca-identity-edit" aria-hidden="true"><Icon icon={EditIcon} size="sm" /></span>
          </button>
          <Field label={tr("customaction.editor.name")} htmlFor={`${ids}-name`} error={errors.name}>
            <TextInput
              id={`${ids}-name`}
              className="ca-name-input"
              invalid={!!errors.name}
              value={draft.name}
              maxLength={ACTION_LIMITS.name}
              placeholder={placeholderName}
              autoComplete="off"
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
        </div>

        <Field
          label={tr("customaction.editor.command")}
          htmlFor={`${ids}-command`}
          error={errors.command}
          hint={tr("customaction.editor.commandHint")}
        >
          <div className="ca-command">
            <span className="ca-command-prompt" aria-hidden="true">$</span>
            <Textarea
              id={`${ids}-command`}
              className="ca-command-input"
              invalid={!!errors.command}
              value={draft.command}
              autoGrow
              minRows={2}
              maxRows={10}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="npm test"
              onChange={(event) => set("command", event.target.value)}
            />
          </div>
        </Field>

        <Field label={tr("customaction.editor.whenPressed")} error={errors.mode}>
          <div className="ca-modes" role="radiogroup" aria-label={tr("customaction.editor.whenPressed")}>
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={draft.mode === mode.id}
                className="ca-mode"
                data-mode={mode.id}
                onClick={() => set("mode", mode.id)}
              >
                <span className="ca-mode-icon"><Icon icon={mode.icon} size="md" /></span>
                <span className="ca-mode-copy">
                  <span className="ca-mode-title">{tr(mode.title)}</span>
                  <span className="ca-mode-body">{tr(mode.body)}</span>
                </span>
              </button>
            ))}
          </div>
        </Field>

        <div className="ca-reveal" data-open={draft.mode === "chat" || undefined} aria-hidden={draft.mode !== "chat"}>
          <div className="ca-reveal-inner">
            <section className="ca-chat-options" aria-label={tr("customaction.editor.chatSection")}>
              {!snapshot.canChat && snapshot.status === "ready" && (
                <p className="ca-field-hint ca-chat-blocked">{tr("customaction.editor.chatUnavailable")}</p>
              )}
              <Field label={tr("customaction.editor.agent")} error={errors["chat.harnessId"] ?? errors["chat.model"]}>
                {draft.mode === "chat" && (
                  <ChatTarget
                    projectId={ownerProjectId ?? projectId}
                    harnessId={draft.harnessId}
                    model={draft.model}
                    onChange={(next) => setDraft((current) => {
                      const { harnessId: _h, model: _m, ...rest } = current;
                      return { ...rest, ...(next.harnessId ? { harnessId: next.harnessId } : {}), ...(next.model ? { model: next.model } : {}) };
                    })}
                  />
                )}
              </Field>
              <Field
                label={tr("customaction.editor.instructions")}
                htmlFor={`${ids}-prompt`}
                error={errors["chat.prompt"]}
                hint={tr("customaction.editor.instructionsHint", { placeholder: OUTPUT_PLACEHOLDER })}
              >
                <Textarea
                  id={`${ids}-prompt`}
                  className="ca-prompt-input"
                  invalid={!!errors["chat.prompt"]}
                  value={draft.prompt}
                  autoGrow
                  minRows={3}
                  maxRows={10}
                  placeholder={tr("customaction.editor.instructionsPlaceholder")}
                  tabIndex={draft.mode === "chat" ? undefined : -1}
                  onChange={(event) => set("prompt", event.target.value)}
                />
              </Field>
              <Field label={tr("customaction.editor.startChat")} error={errors["chat.when"]}>
                <div className="ca-seg" role="radiogroup" aria-label={tr("customaction.editor.startChat")}>
                  {WHEN.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={draft.when === value}
                      tabIndex={draft.mode === "chat" ? undefined : -1}
                      className="ca-seg-option"
                      onClick={() => set("when", value)}
                    >
                      {tr(label)}
                    </button>
                  ))}
                </div>
              </Field>
            </section>
          </div>
        </div>

        <Field label={tr("customaction.editor.availableIn")} error={errors.projectId}>
          <div className="ca-seg ca-scope" role="radiogroup" aria-label={tr("customaction.editor.availableIn")}>
            <button
              type="button"
              role="radio"
              aria-checked={draft.scope === "project"}
              disabled={!project}
              className="ca-seg-option"
              onClick={() => set("scope", "project")}
            >
              {project ? <ProjectGlyph project={project} /> : null}
              <span className="ca-seg-text">{project?.name ?? tr("customaction.editor.thisProject")}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={draft.scope === "global"}
              className="ca-seg-option"
              onClick={() => set("scope", "global")}
            >
              <Icon icon={GlobeIcon} size="sm" />
              <span className="ca-seg-text">{tr("customaction.scope.all")}</span>
            </button>
          </div>
        </Field>

        <div className="ca-field ca-confirm-field">
          <div className="ca-field-head">
            <span className="ca-field-label" id={`${ids}-confirm`}>{tr("customaction.editor.confirm")}</span>
            <Switch labelledBy={`${ids}-confirm`} checked={draft.confirm} onChange={(value) => set("confirm", value)} />
          </div>
          <p className="ca-field-hint">{tr("customaction.editor.confirmHint")}</p>
        </div>

        <div className="ca-reveal" data-open={draft.confirm || undefined} aria-hidden={!draft.confirm}>
          <div className="ca-reveal-inner">
            <Field
              label={tr("customaction.editor.confirmMessage")}
              htmlFor={`${ids}-confirm-message`}
              error={errors["confirm.message"]}
              hint={tr("customaction.editor.confirmMessageHint")}
            >
              <Textarea
                id={`${ids}-confirm-message`}
                className="ca-confirm-input"
                invalid={!!errors["confirm.message"]}
                value={draft.confirmMessage}
                autoGrow
                minRows={2}
                maxRows={6}
                maxLength={ACTION_LIMITS.confirmMessage}
                placeholder={tr("customaction.editor.confirmMessagePlaceholder")}
                tabIndex={draft.confirm ? undefined : -1}
                onChange={(event) => set("confirmMessage", event.target.value)}
              />
            </Field>
          </div>
        </div>

        {canPlace && appliesHere && (
          <div className="ca-field ca-rail-field">
            <div className="ca-field-head">
              <span className="ca-field-label" id={`${ids}-rail`}>{tr("customaction.editor.showOnRail")}</span>
              <Switch labelledBy={`${ids}-rail`} checked={draft.onRail} onChange={(value) => set("onRail", value)} />
            </div>
            <p className="ca-field-hint">{tr("customaction.editor.showOnRailHint")}</p>
          </div>
        )}

        {failure && <p className="ca-editor-failure" role="alert">{failure}</p>}
        {!snapshot.canManage && snapshot.status === "ready" && (
          <p className="ca-editor-failure" role="status">{snapshot.blocked ?? tr("customaction.readOnly")}</p>
        )}
      </div>
      <IconPicker
        open={iconOpen}
        anchorRef={iconButton}
        icon={draft.icon}
        color={draft.color}
        onIcon={(icon) => set("icon", icon)}
        onColor={(color) => set("color", color)}
        onClose={() => setIconOpen(false)}
      />
    </ResponsiveOverlay>
  );
}
