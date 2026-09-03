// "Clone repository" — a project-create source contributed to the folder
// picker's `project.create.options` slot. It is disclosed *inline* inside the
// picker (no nested dialog): the picker's own folder browser is the clone
// destination, so the only extra fields are the repository URL and an optional
// name. A rarely-used "on a server" switch keeps the SSH-clone path.
import { useEffect, useRef, useState } from "react";
import { api, type SshConnectionWithStatus } from "@polyth/session/web-api";
import { cloneProject } from "../../../apps/web/src/init.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";

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
  const [target, setTarget] = useState<"local" | "ssh">("local");
  const [connections, setConnections] = useState<SshConnectionWithStatus[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [sshParent, setSshParent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const busy = submitting || ctx.busy;

  useEffect(() => {
    void api.sshConnections().then((result) => {
      setConnections(result.items);
      if (result.items[0]) setConnectionId(result.items[0].id);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (target !== "ssh" || !connectionId) return;
    void api.sshBrowse(connectionId).then((result) => setSshParent(result.path)).catch(() => undefined);
  }, [connectionId, target]);

  const parentPath = target === "ssh" ? sshParent.trim() : ctx.browsedPath;
  const canSubmit = !busy && repository.trim() !== "" && parentPath !== ""
    && (target !== "ssh" || connectionId !== "");

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      await cloneProject({
        repository: repository.trim(),
        parentPath,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(target === "ssh" ? { remote: { kind: "ssh", connectionId } } : {}),
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

      {connections.length > 0 && (
        <label className="folder-source-field">
          <span>{tr("gitprojectsource.target")}</span>
          <Select
            label={tr("gitprojectsource.target")}
            value={target}
            disabled={busy}
            onChange={(value) => setTarget(value as "local" | "ssh")}
            options={[
              { value: "local", label: tr("gitview.local") },
              { value: "ssh", label: tr("gitprojectsource.sshServer") },
            ]}
          />
        </label>
      )}

      {target === "ssh" && (
        <>
          <label className="folder-source-field">
            <span>{tr("gitprojectsource.sshServer")}</span>
            <Select
              label={tr("gitprojectsource.sshServer")}
              value={connectionId}
              disabled={busy || connections.length === 0}
              onChange={setConnectionId}
              options={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
            />
          </label>
          <label className="folder-source-field">
            <span>{tr("gitprojectsource.destinationParentFolder")}</span>
            <TextInput
              className="mono"
              value={sshParent}
              placeholder="/home/user/projects"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setSshParent(event.target.value)}
            />
          </label>
        </>
      )}

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

      {target === "local" && (
        <p className="folder-source-hint">
          {tr("gitprojectsource.cloneDestinationHint")}
          <code className="mono">{ctx.browsedPath || "…"}</code>
        </p>
      )}

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
  const otherArmed = ctx.armedId !== null && ctx.armedId !== SOURCE_ID;

  return (
    <>
      <Button
        ref={chipRef}
        type="button"
        variant="ghost"
        className="ghost-link git-clone-source folder-source-chip"
        aria-expanded={open}
        disabled={ctx.busy || otherArmed}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {tr("gitprojectsource.cloneRepository")}
      </Button>
      {open && <CloneInlinePanel ctx={ctx} onCancel={close} />}
    </>
  );
}
