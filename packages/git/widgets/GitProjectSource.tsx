// "Clone repository" — a project-create source contributed to the folder
// picker's `project.create.options` slot. It is disclosed inline inside the
// picker: the picker's folder browser remains the clone destination.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@polyth/contracts";
import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  inferSourceControlProvider,
  matchingSourceControlProfiles,
  parseSourceControlRemoteUrl,
  type SourceControlRemote,
} from "@polyth/contracts/source-control";
import type { WebPackageHost } from "@polyth/web-sdk";
import { cloneProject } from "../../../apps/web/src/init.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import {
  setRepositorySourceControlProfile,
  useSourceControlProfileState,
} from "./sourceControlProfiles.ts";

const SOURCE_ID = "git-clone-project";
const AUTO_PROFILE = "auto";

const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const repoName = (url: string): string => {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  return trimmed.split(/[/:]/).pop() ?? "";
};

const providerLabel = (provider: "github" | "gitlab" | "generic"): string =>
  provider === "github" ? "GitHub" : provider === "gitlab" ? "GitLab" : "Git";

/** Generic remote parsing is intentionally broader than clone validation:
 * existing Git config may use user@host:path, while the server accepts SCP
 * clone syntax only as git@host:path. Keep the UI and backend allowlists equal. */
const parseCloneRemote = (repository: string): SourceControlRemote | null => {
  const value = repository.trim();
  const remote = parseSourceControlRemoteUrl(value);
  if (!remote || value.includes("://")) return remote;
  return /^git@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:/i.test(value) ? remote : null;
};

interface GitProjectSourceProps extends Record<string, unknown> {
  host: WebPackageHost;
}

interface HostContext {
  host: WebPackageHost;
  busy: boolean;
  browsedPath: string;
  armedId: string | null;
  arm: (id: string, opts?: { soloBrowser?: boolean }) => void;
  disarm: (id: string) => void;
  onProjectOpened?: () => void;
}

function readContext(props: GitProjectSourceProps): HostContext {
  return {
    host: props.host as WebPackageHost,
    busy: props.busy === true,
    browsedPath: typeof props.browsedPath === "string" ? props.browsedPath : "",
    armedId: typeof props.armedId === "string" ? props.armedId : null,
    arm: typeof props.arm === "function" ? props.arm as HostContext["arm"] : () => undefined,
    disarm: typeof props.disarm === "function" ? props.disarm as (id: string) => void : () => undefined,
    onProjectOpened: typeof props.onProjectOpened === "function" ? props.onProjectOpened as () => void : undefined,
  };
}

function CloneInlinePanel({ ctx, onCancel }: { ctx: HostContext; onCancel: () => void }) {
  const profileState = useSourceControlProfileState();
  const [repository, setRepository] = useState("");
  const [name, setName] = useState("");
  const [profileChoice, setProfileChoice] = useState(AUTO_PROFILE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const configure = useRef(new Map<string, (projectId: string) => Promise<void>>());
  const [created, setCreated] = useState<Project | null>(null);
  const onConfigure = useCallback((id: string, callback?: (projectId: string) => Promise<void>) => {
    if (callback) configure.current.set(id, callback);
    else configure.current.delete(id);
  }, []);

  const remote = useMemo(() => parseCloneRemote(repository), [repository]);
  const compatibleProfiles = useMemo(
    () => remote ? matchingSourceControlProfiles(profileState.profiles, remote) : [],
    [profileState.profiles, remote],
  );
  const provider = inferSourceControlProvider(remote, profileState.profiles);
  const suggestedProfile = useMemo(() => {
    const global = compatibleProfiles.find((profile) => profile.id === profileState.globalDefaultProfileId);
    return global ?? (compatibleProfiles.length === 1 ? compatibleProfiles[0]! : null);
  }, [compatibleProfiles, profileState.globalDefaultProfileId]);
  const effectiveProfileId = profileChoice === AUTO_PROFILE
    ? suggestedProfile?.id ?? SYSTEM_SOURCE_CONTROL_PROFILE_ID
    : profileChoice;
  const effectiveProfile = profileState.profiles.find((profile) => profile.id === effectiveProfileId) ?? null;

  useEffect(() => {
    setProfileChoice(AUTO_PROFILE);
  }, [remote?.hostname]);

  const busy = submitting || ctx.busy;
  const parentPath = ctx.browsedPath;
  const canSubmit = !busy && remote !== null && parentPath !== "";

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const project: Project = created ?? await cloneProject({
        repository: repository.trim(),
        parentPath,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setCreated(project);
      const automaticNeedsOverride = profileChoice === AUTO_PROFILE
        && suggestedProfile !== null
        && suggestedProfile.id !== profileState.globalDefaultProfileId;
      if (profileChoice !== AUTO_PROFILE || automaticNeedsOverride) {
        setRepositorySourceControlProfile(project.id, effectiveProfileId);
      }
      for (const callback of configure.current.values()) await callback(project.id);
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
          placeholder="https://git.example.com/group/repo.git"
          spellCheck={false}
          disabled={busy || !!created}
          onChange={(event) => setRepository(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) void submit(); }}
        />
      </label>

      {remote && (
        <div className="folder-source-field source-control-clone-resolution">
          <span>Source control</span>
          <div className="folder-source-hint">
            <strong>{providerLabel(provider)}{remote.hostname !== "github.com" && remote.hostname !== "gitlab.com" ? ` · ${remote.hostname}` : ""}</strong>
            <span>{remote.protocol.toUpperCase()}</span>
          </div>
          <select
            aria-label="Source control profile"
            value={profileChoice}
            disabled={busy || !!created}
            onChange={(event) => setProfileChoice(event.target.value)}
          >
            <option value={AUTO_PROFILE}>Automatic · {suggestedProfile?.label ?? "System Git"}</option>
            <option value={SYSTEM_SOURCE_CONTROL_PROFILE_ID}>System Git</option>
            {compatibleProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.label}{profile.username ? ` · @${profile.username}` : ""}</option>
            ))}
          </select>
          <small className="muted">
            {effectiveProfile
              ? `${effectiveProfile.label} · ${effectiveProfile.authentication.mode}`
              : "Use the machine's existing SSH agent, credential helper, and Git configuration."}
          </small>
        </div>
      )}

      <label className="folder-source-field">
        <span>{tr("gitprojectsource.projectName")} <em>{tr("worktreesessiondialog.optional")}</em></span>
        <TextInput
          value={name}
          placeholder={repoName(repository) || "repo"}
          spellCheck={false}
          disabled={busy || !!created}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <p className="folder-source-hint">
        {tr("gitprojectsource.cloneDestinationHint")}
        <code className="mono">{ctx.browsedPath || "…"}</code>
      </p>

      <ctx.host.ui.Slot slot="project.repository.options" context={{
        repository,
        onConfigure,
        sourceControlProfileId: effectiveProfileId,
        sourceControlProvider: provider,
      }} />

      {error && <div className="form-error folder-error" role="alert">{error}</div>}

      <div className="folder-source-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{tr("common.cancel")}</Button>
        <Button size="sm" variant="primary" busy={submitting} disabled={!canSubmit} onClick={() => void submit()}>
          {created ? tr("common.retry") : tr("gitprojectsource.cloneRepository")}
        </Button>
      </div>
    </div>
  );
}

export default function GitProjectSource(props: Record<string, unknown>) {
  const ctx = readContext(props as GitProjectSourceProps);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const armRef = useRef(ctx.arm);
  const disarmRef = useRef(ctx.disarm);
  armRef.current = ctx.arm;
  disarmRef.current = ctx.disarm;

  useEffect(() => {
    if (!open) return;
    armRef.current(SOURCE_ID, { soloBrowser: false });
    return () => disarmRef.current(SOURCE_ID);
  }, [open]);

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
