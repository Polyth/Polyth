// "Clone repository" — a project-create source contributed to the folder
// picker's `project.create.options` slot. It is disclosed *inline* inside the
// picker (no nested dialog): the picker's own folder browser is the clone
// destination, so the only field is the repository URL (plus an optional
// name). Cloning onto an SSH host lives in the SSH source, whose server picker
// and remote browser already point at the destination.
import { useEffect, useRef, useState } from "react";
import { cloneProject } from "../../../apps/web/src/init.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, TextInput } from "../../../apps/web/src/components/ui/index.ts";

const SOURCE_ID = "git-clone-project";

const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** Best-effort project name preview from a clone URL (`…/repo.git` → `repo`). */
const repoName = (url: string): string => {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const tail = trimmed.split(/[/:]/).pop() ?? "";
  return tail;
};

interface HostContext {
  busy: boolean;
  browsedPath: string;
  armedId: string | null;
  arm: (id: string, opts?: { soloBrowser?: boolean }) => void;
  disarm: (id: string) => void;
  onProjectOpened?: () => void;
}

function readContext(props: Record<string, unknown>): HostContext {
  return {
    busy: props.busy === true,
    browsedPath: typeof props.browsedPath === "string" ? props.browsedPath : "",
    armedId: typeof props.armedId === "string" ? props.armedId : null,
    arm: typeof props.arm === "function"
      ? props.arm as HostContext["arm"]
      : () => undefined,
    disarm: typeof props.disarm === "function" ? props.disarm as (id: string) => void : () => undefined,
    onProjectOpened: typeof props.onProjectOpened === "function"
      ? props.onProjectOpened as () => void
      : undefined,
  };
}

function CloneInlinePanel({ ctx, onCancel }: { ctx: HostContext; onCancel: () => void }) {
  const [repository, setRepository] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const busy = submitting || ctx.busy;

  // The picker's own folder browser is the destination — no extra path field.
  const parentPath = ctx.browsedPath;
  const canSubmit = !busy && repository.trim() !== "" && parentPath !== "";

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      await cloneProject({
        repository: repository.trim(),
        parentPath,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      ctx.onProjectOpened?.();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="folder-source-panel git-clone-panel"
      role="group"
      aria-label={tr("gitprojectsource.cloneRepository")}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); if (!busy) onCancel(); }
      }}
    >
      <label className="folder-source-field">
        <span>{tr("gitprojectsource.repositoryUrl")}</span>
        <TextInput
          autoFocus
          value={repository}
          placeholder="https://github.com/org/repo.git"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setRepository(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) void submit(); }}
        />
      </label>

      <label className="folder-source-field">
        <span>{tr("gitprojectsource.projectName")} <em>{tr("worktreesessiondialog.optional")}</em></span>
        <TextInput
          value={name}
          placeholder={repoName(repository) || "repo"}
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <p className="folder-source-hint">
        {tr("gitprojectsource.cloneDestinationHint")}
        <code className="mono">{ctx.browsedPath || "…"}</code>
      </p>

      {error && <div className="form-error folder-error" role="alert">{error}</div>}

      <div className="folder-source-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{tr("common.cancel")}</Button>
        <Button size="sm" variant="primary" busy={submitting} disabled={!canSubmit} onClick={() => void submit()}>
          {tr("gitprojectsource.cloneRepository")}
        </Button>
      </div>
    </div>
  );
}

export default function GitProjectSource(props: Record<string, unknown>) {
  const ctx = readContext(props);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const armRef = useRef(ctx.arm);
  const disarmRef = useRef(ctx.disarm);
  armRef.current = ctx.arm;
  disarmRef.current = ctx.disarm;

  // Reflect this panel's open state into the shared picker, and always release
  // the picker on unmount.
  useEffect(() => {
    if (!open) return;
    armRef.current(SOURCE_ID, { soloBrowser: false });
    return () => disarmRef.current(SOURCE_ID);
  }, [open]);

  // Another source armed itself — collapse ours.
  useEffect(() => {
    if (open && ctx.armedId !== null && ctx.armedId !== SOURCE_ID) setOpen(false);
  }, [ctx.armedId, open]);

  const close = () => {
    setOpen(false);
    chipRef.current?.focus();
  };
  return (
    <>
      <Button
        ref={chipRef}
        type="button"
        variant="ghost"
        className="ghost-link git-clone-source folder-source-chip"
        aria-expanded={open}
        disabled={ctx.busy}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {tr("gitprojectsource.cloneRepository")}
      </Button>
      {open && <CloneInlinePanel ctx={ctx} onCancel={close} />}
    </>
  );
}
