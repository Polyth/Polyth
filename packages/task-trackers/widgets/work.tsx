import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type {
  HarnessSelection,
  ModelRef,
  SessionProjection,
  TaskTrackerAttachmentInput,
  TaskTrackerBoardDto,
  TaskTrackerProvider,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import {
  AddIcon,
  Button,
  CloseIcon,
  IconButton,
  ImageIcon,
  Notice,
  SendIcon,
  Switch,
  TextInput,
  Textarea,
} from "../../../apps/web/src/components/ui/index.ts";
import { MOD } from "../../../apps/web/src/format.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import ModelPicker from "@polyth/models/model-picker";
import { useHarnessColors, useOtherHarnessModels, useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { api, type TaskTrackerDispatchInput } from "./api.ts";
import { PROVIDER_LABELS, ProviderMark, providerNouns } from "./brand.tsx";
import { tt } from "./i18n.ts";
import { friendly, TASK_TRACKER_CHANGED, taskTrackerHost } from "./store.ts";
import type { TaskTrackerDispatchResultDto, TaskTrackerTaskLinkDto } from "../src/types.ts";
import { isImeComposing } from "@polyth/web-sdk";

/**
 * Task work: create tasks, send them to agents in new sessions, and show which
 * sessions are working on which task.
 */

const noop = () => () => {};

/** The project new agent sessions start in: the one the user is looking at. */
export function useActiveProjectId(): string | null {
  const host = taskTrackerHost();
  return useSyncExternalStore(
    host?.store.subscribe ?? noop,
    () => host?.store.getSnapshot().activeProjectId ?? null,
    () => null,
  );
}

/** The agent and model the composer would use, so dispatch matches it. */
function executionFor(projectId: string): Pick<TaskTrackerDispatchInput, "harness" | "model"> {
  const draft = taskTrackerHost()?.executionDraft.get(projectId);
  if (!draft) return {};
  const pinned = draft.harnessSelection.mode === "pinned" || draft.harnessSelectionExplicit === true;
  const model: ModelRef | undefined = draft.model
    ? {
        providerID: draft.model.providerID,
        modelID: draft.model.modelID,
        ...(draft.model.variant ? { variant: draft.model.variant } : {}),
      }
    : undefined;
  return {
    ...(pinned ? { harness: draft.harnessSelection } : {}),
    ...(model ? { model } : {}),
  };
}

/** The agent and model a task's session starts with. */
export interface TaskStartAgent {
  harness?: HarnessSelection;
  model?: ModelRef;
}

/** How a task's agent session starts: in the project's own checkout or an
 *  isolated one, whether the app then switches to it or leaves it working in
 *  the background, and, per project, an agent and model chosen for tasks. A
 *  project without a choice follows the composer. A device preference,
 *  remembered for the next start. */
export interface TaskStartOptions {
  isolated: boolean;
  open: boolean;
  agents?: Readonly<Record<string, TaskStartAgent>>;
}

const START_OPTIONS_KEY = "polyth.task-trackers.start";
const DEFAULT_START_OPTIONS: TaskStartOptions = { isolated: false, open: false };
const startListeners = new Set<() => void>();
let startOptions: TaskStartOptions | null = null;

const storedHarness = (value: unknown): HarnessSelection | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.mode === "auto") return { mode: "auto" };
  return item.mode === "pinned" && typeof item.harnessId === "string" && item.harnessId
    ? { mode: "pinned", harnessId: item.harnessId }
    : undefined;
};

const storedModel = (value: unknown): ModelRef | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.providerID !== "string" || !item.providerID) return undefined;
  if (typeof item.modelID !== "string" || !item.modelID) return undefined;
  return {
    providerID: item.providerID,
    modelID: item.modelID,
    ...(typeof item.variant === "string" && item.variant ? { variant: item.variant } : {}),
  };
};

const storedAgents = (value: unknown): Record<string, TaskStartAgent> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const agents: Record<string, TaskStartAgent> = {};
  for (const [projectId, raw] of Object.entries(value as Record<string, unknown>)) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const harness = storedHarness(item.harness);
    const model = storedModel(item.model);
    if (harness || model) agents[projectId] = { ...(harness ? { harness } : {}), ...(model ? { model } : {}) };
  }
  return Object.keys(agents).length > 0 ? agents : undefined;
};

export function taskStartOptions(): TaskStartOptions {
  if (startOptions) return startOptions;
  try {
    const stored = JSON.parse(localStorage.getItem(START_OPTIONS_KEY) ?? "null") as Record<string, unknown> | null;
    const agents = storedAgents(stored?.agents);
    startOptions = {
      isolated: stored?.isolated === true,
      open: stored?.open === true,
      ...(agents ? { agents } : {}),
    };
  } catch {
    startOptions = DEFAULT_START_OPTIONS;
  }
  return startOptions;
}

export function setTaskStartOptions(patch: Partial<TaskStartOptions>): void {
  startOptions = { ...taskStartOptions(), ...patch };
  try { localStorage.setItem(START_OPTIONS_KEY, JSON.stringify(startOptions)); } catch { /* preference only */ }
  for (const listener of startListeners) listener();
}

/** Remember the agent and model for this project's task starts; `undefined`
 *  goes back to following the composer. */
export function setTaskStartAgent(projectId: string, agent: TaskStartAgent | undefined): void {
  const { [projectId]: _previous, ...others } = taskStartOptions().agents ?? {};
  setTaskStartOptions({ agents: agent && (agent.harness || agent.model) ? { ...others, [projectId]: agent } : others });
}

/** The agent and model a task started in this project gets: the one chosen
 *  for tasks here, otherwise whatever the composer would use. */
export function taskStartAgent(projectId: string, options: TaskStartOptions = taskStartOptions()): TaskStartAgent {
  return options.agents?.[projectId] ?? executionFor(projectId);
}

/** Test seam: forget the remembered choice between isolated renders. */
export function resetTaskStartOptions(): void {
  startOptions = null;
}

const subscribeStart = (listener: () => void) => {
  startListeners.add(listener);
  return () => { startListeners.delete(listener); };
};

export function useTaskStartOptions(): TaskStartOptions {
  return useSyncExternalStore(subscribeStart, taskStartOptions, () => DEFAULT_START_OPTIONS);
}

/** Starts one agent session per task with the remembered start options (or
 *  the given ones), then switches to the first started session when asked. */
export async function dispatchTasks(
  projectId: string,
  tasks: ReadonlyArray<Pick<TaskTrackerTaskDto, "provider" | "id">>,
  instructions = "",
  options: TaskStartOptions = taskStartOptions(),
): Promise<TaskTrackerDispatchResultDto[]> {
  const { results } = await api.taskTrackerDispatch({
    projectId,
    tasks: tasks.map((task) => ({ provider: task.provider, taskId: task.id })),
    ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    ...taskStartAgent(projectId, options),
    ...(options.isolated ? { isolated: true } : {}),
  });
  window.dispatchEvent(new Event(TASK_TRACKER_CHANGED));
  const started = results.find((result) => result.sessionId)?.sessionId;
  if (options.open && started) openSession(started);
  return results;
}

/** The composer's own agent tabs and model picker, choosing what a task
 *  started in this project runs on. Until something is picked here it shows,
 *  and starts with, the composer's current choice. */
export function TaskModelPicker({ projectId, labelledBy }: { projectId: string; labelledBy?: string }) {
  const host = taskTrackerHost();
  const options = useTaskStartOptions();
  // The composer's choice as a string, so an unchanged draft is a stable snapshot.
  const composerKey = useSyncExternalStore(
    host?.executionDraft.subscribe ?? noop,
    () => JSON.stringify(executionFor(projectId)),
    () => "{}",
  );
  const chosen = options.agents?.[projectId];
  const agent = useMemo<TaskStartAgent>(() => chosen ?? JSON.parse(composerKey) as TaskStartAgent, [chosen, composerKey]);
  const project = useStore((state) => state.projectRegistry.projects.find((item) => item.id === projectId));
  const globalModels = useStore((state) => state.models);
  const globalAgents = useStore((state) => state.agents);
  const spaceId = project?.spaceId;
  const pinnedHarnessId = agent.harness?.mode === "pinned" ? agent.harness.harnessId : undefined;
  const catalog = useRuntimeCatalog(null, globalModels, globalAgents, {
    projectId,
    ...(spaceId ? { spaceId } : {}),
    ...(project?.path ? { cwd: project.path } : {}),
    ...(pinnedHarnessId ? { harnessId: pinnedHarnessId } : {}),
  });
  const catalogHarnessId = pinnedHarnessId ?? catalog.harnessId;
  const models = useMemo(
    () => catalogHarnessId
      ? catalog.models.filter((candidate) => !candidate.harnessId || candidate.harnessId === catalogHarnessId)
      : catalog.models,
    [catalog.models, catalogHarnessId],
  );
  const otherHarnesses = useOtherHarnessModels({
    projectId,
    ...(spaceId ? { spaceId } : {}),
    ...(project?.path ? { cwd: project.path } : {}),
    ...(catalogHarnessId ? { excludeHarnessId: catalogHarnessId } : {}),
  });
  const harnessColors = useHarnessColors(projectId, spaceId);
  const selection: HarnessSelection = agent.harness ?? { mode: "auto" };
  const Slot = host?.ui.Slot;
  const header = Slot ? (
    <Slot
      slot="modelPicker.header"
      context={{
        ...(spaceId ? { spaceId } : {}),
        projectId,
        harnessSelection: selection,
        ...(catalogHarnessId ? { resolvedHarnessId: catalogHarnessId } : {}),
        pendingHarnessSelection: selection,
        onSelectHarness: (next: HarnessSelection) => {
          // A model belongs to its agent; a different agent starts on its default.
          const same = next.mode === "pinned" && next.harnessId === pinnedHarnessId;
          setTaskStartAgent(projectId, { harness: next, ...(same && agent.model ? { model: agent.model } : {}) });
        },
      }}
    />
  ) : undefined;
  return (
    <div className="tt-model-picker" {...(labelledBy ? { role: "group", "aria-labelledby": labelledBy } : {})}>
      <ModelPicker
        models={models}
        {...(catalogHarnessId ? { harnessId: catalogHarnessId } : {})}
        {...(agent.model ? { value: { ...agent.model, ...(catalogHarnessId ? { harnessId: catalogHarnessId } : {}) } } : {})}
        catalogLoading={catalog.discovery.state === "pending"}
        emptyLabel={tt("tasktrackers.start.modelComposer")}
        otherHarnesses={otherHarnesses}
        harnessColors={harnessColors}
        {...(header ? { header } : {})}
        onPick={(picked) => {
          if (!picked) {
            setTaskStartAgent(projectId, undefined);
            return;
          }
          const harnessId = picked.harnessId ?? pinnedHarnessId;
          setTaskStartAgent(projectId, {
            ...(harnessId ? { harness: { mode: "pinned", harnessId } } : agent.harness ? { harness: agent.harness } : {}),
            model: {
              providerID: picked.providerID,
              modelID: picked.modelID,
              ...(picked.variant ? { variant: picked.variant } : {}),
            },
          });
        }}
      />
    </div>
  );
}

/** What the agent runs on, where it works and whether to follow it there. */
export function TaskStartOptionsFields({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const options = useTaskStartOptions();
  const id = useId();
  return (
    <div className="tt-start-options">
      <div className={`tt-start-row${disabled ? " is-disabled" : ""}`} {...(disabled ? { inert: true } : {})}>
        <span id={`${id}-model`}>{tt("tasktrackers.start.model")}</span>
        <TaskModelPicker projectId={projectId} labelledBy={`${id}-model`} />
      </div>
      <div className="tt-start-row">
        <span id={`${id}-workspace`}>{tt("tasktrackers.start.workspace")}</span>
        <div className="tt-target" role="radiogroup" aria-labelledby={`${id}-workspace`}>
          {([[false, tt("tasktrackers.start.shared")], [true, tt("tasktrackers.start.isolated")]] as const).map(([isolated, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={options.isolated === isolated}
              className={options.isolated === isolated ? "active" : ""}
              title={isolated ? tt("tasktrackers.start.isolatedHint") : tt("tasktrackers.start.sharedHint")}
              disabled={disabled}
              onClick={() => setTaskStartOptions({ isolated })}
            >{label}</button>
          ))}
        </div>
      </div>
      <div className="tt-start-row">
        <span id={`${id}-open`}>{tt("tasktrackers.start.openSession")}</span>
        <Switch
          checked={options.open}
          disabled={disabled}
          labelledBy={`${id}-open`}
          onChange={(open) => setTaskStartOptions({ open })}
        />
      </div>
    </div>
  );
}

export function openSession(sessionId: string): void {
  void taskTrackerHost()?.conversation.openSession(sessionId);
}

/** Space-wide task → session index, refreshed whenever task work changes. */
export function useTaskLinks(): Map<string, TaskTrackerTaskLinkDto[]> {
  const [links, setLinks] = useState<Map<string, TaskTrackerTaskLinkDto[]>>(() => new Map());
  useEffect(() => {
    let active = true;
    const load = () => {
      void api.taskTrackerLinks()
        .then((items) => {
          if (!active) return;
          const next = new Map<string, TaskTrackerTaskLinkDto[]>();
          for (const item of items) {
            const key = `${item.provider}:${item.taskId}`;
            next.set(key, [...next.get(key) ?? [], item]);
          }
          setLinks(next);
        })
        .catch(() => { /* decoration only; the board still works */ });
    };
    load();
    window.addEventListener(TASK_TRACKER_CHANGED, load);
    return () => {
      active = false;
      window.removeEventListener(TASK_TRACKER_CHANGED, load);
    };
  }, []);
  return links;
}

function useSessions(ids: readonly string[]): Array<SessionProjection | undefined> {
  const host = taskTrackerHost();
  // Re-render when any of these sessions' title or status changes.
  useSyncExternalStore(
    host?.sessions.subscribe ?? noop,
    () => ids.map((id) => {
      const session = host?.sessions.get(id);
      return session ? `${session.title}\u0000${session.status}` : "";
    }).join("\u0001"),
    () => "",
  );
  return ids.map((id) => host?.sessions.get(id));
}

const ACTIVE = new Set(["working", "waiting", "reconciling", "epoch-pending"]);

/** Agent sessions linked to one task, newest first, each one tap away. */
export function AgentSessions({ links }: { links: readonly TaskTrackerTaskLinkDto[] }) {
  const sessions = useSessions(links.map((link) => link.sessionId));
  if (links.length === 0) return null;
  return (
    <ul className="tt-agent-sessions" aria-label={tt("tasktrackers.work.agentSessions")}>
      {links.map((link, index) => {
        const session = sessions[index];
        const working = session ? ACTIVE.has(session.status) : false;
        return (
          <li key={link.sessionId}>
            <button type="button" onClick={() => openSession(link.sessionId)}>
              <i className={working ? "working" : session?.status ?? ""} aria-hidden="true" />
              <span>
                <strong>{session?.title || link.taskKey}</strong>
                <small>{working ? tt("tasktrackers.menu.agentWorking") : session?.status === "failed" ? tt("tasktrackers.work.needsAttention") : tt("tasktrackers.work.openSession")}</small>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGES_MAX = 10;

interface ComposerImage extends TaskTrackerAttachmentInput {
  preview: string;
}

const readImage = (file: File) => new Promise<ComposerImage>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const preview = String(reader.result);
    resolve({ name: file.name, mimeType: file.type, data: preview.slice(preview.indexOf(",") + 1), preview });
  };
  reader.onerror = () => reject(reader.error ?? new Error(tt("tasktrackers.work.imageReadFailed")));
  reader.readAsDataURL(file);
});

const isFinePointer = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;

const hasFiles = (event: DragEvent): boolean => [...event.dataTransfer?.types ?? []].includes("Files");

interface ComposerDraft {
  title: string;
  description: string;
  images: ComposerImage[];
  startAgent: boolean;
}

/** Unsent text outlives the composer: the package window can close under it
 *  (an outside click, the launcher, a task opened instead), and reopening the
 *  board brings the draft back. Only creating the task or Cancel discards it.
 *  Kept in memory for the page's lifetime, keyed by board. */
const composerDrafts = new Map<string, ComposerDraft>();
const draftKey = (provider: TaskTrackerProvider, boardId: string) => `${provider}:${boardId}`;

export function hasComposerDraft(provider: TaskTrackerProvider, boardId: string): boolean {
  return composerDrafts.has(draftKey(provider, boardId));
}

/** Per-task text typed into a field that may unmount before it is sent. */
const fieldDrafts = new Map<string, string>();

/** Puts text a rejected write would otherwise lose back into its field draft,
 *  after whatever the person has typed there since (or in its place). */
export function restoreFieldDraft(key: string, text: string, append = true): void {
  const current = append ? fieldDrafts.get(key)?.trim() : undefined;
  fieldDrafts.set(key, current ? `${current}\n\n${text}` : text);
}

/** Taken (and forgotten) once: a draft a rejected write handed back. */
export function takeFieldDraft(key: string): string | undefined {
  const value = fieldDrafts.get(key);
  fieldDrafts.delete(key);
  return value;
}

export function useFieldDraft(key: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => fieldDrafts.get(key) ?? "");
  useEffect(() => setValue(fieldDrafts.get(key) ?? ""), [key]);
  return [value, (next) => {
    if (next) fieldDrafts.set(key, next);
    else fieldDrafts.delete(key);
    setValue(next);
  }];
}

/** New tracker task, optionally with images and handed straight to an agent.
 *  Renders in the board's detail pane (or over the whole board when it is
 *  narrow), never as a popup. */
export function TaskComposer({
  provider,
  board,
  projectId,
  canStartAgent,
  onClose,
  onCreated,
}: {
  provider: TaskTrackerProvider;
  board: TaskTrackerBoardDto;
  projectId: string | null;
  canStartAgent: boolean;
  onClose: () => void;
  onCreated: (task: TaskTrackerTaskDto, sessionId?: string) => void;
}) {
  const key = draftKey(provider, board.id);
  const [draft] = useState(() => composerDrafts.get(key));
  const [title, setTitle] = useState(draft?.title ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [images, setImages] = useState<ComposerImage[]>(draft?.images ?? []);
  const [startAgent, setStartAgent] = useState(draft?.startAgent ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [finePointer] = useState(isFinePointer);
  const paneRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const agentAvailable = canStartAgent && projectId !== null;
  const noun = providerNouns(provider).task;
  const agentLabelId = `tt-compose-agent-${board.id}`;

  // The exit animation hands control back on `animationend`; this is only a
  // backstop for a backgrounded tab that never paints the last frame.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(leaving, 600);
    return () => clearTimeout(timer);
  }, [leaving]);

  /** Play the exit, then run `then`; reduced motion skips straight to it. */
  const leave = (then: () => void) => {
    const pane = paneRef.current;
    const animation = pane && typeof getComputedStyle === "function" ? getComputedStyle(pane).animationName : "";
    if (!animation || animation === "none") then();
    else setLeaving(() => then);
  };
  // Mirror every edit, so the draft is current whenever the pane unmounts.
  const discarded = useRef(false);
  useEffect(() => {
    if (discarded.current) return;
    if (title || description || images.length > 0) composerDrafts.set(key, { title, description, images, startAgent });
    else composerDrafts.delete(key);
  }, [key, title, description, images, startAgent]);
  const discard = () => {
    discarded.current = true;
    composerDrafts.delete(key);
  };

  const close = () => {
    if (!busy && !leaving) leave(onClose);
  };
  const cancel = () => {
    if (busy || leaving) return;
    discard();
    leave(onClose);
  };

  const addImages = async (files: readonly File[]) => {
    const picked = files.filter((file) => IMAGE_TYPES.includes(file.type));
    if (picked.length === 0) {
      if (files.length > 0) setError(tt("tasktrackers.work.imageTypes"));
      return;
    }
    setError("");
    if (picked.some((file) => file.size > IMAGE_MAX_BYTES)) {
      setError(tt("tasktrackers.work.imageTooLarge"));
      return;
    }
    if (images.length + picked.length > IMAGES_MAX) {
      setError(tt("tasktrackers.work.tooManyImages", { max: IMAGES_MAX }));
      return;
    }
    try {
      const read = await Promise.all(picked.map(readImage));
      setImages((current) => [...current, ...read].slice(0, IMAGES_MAX));
    } catch (cause) {
      setError(friendly(tt("tasktrackers.work.couldNotReadImage"), cause));
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!title.trim() || busy || leaving) return;
    setBusy(true);
    setError("");
    let created: TaskTrackerTaskDto | null = null;
    try {
      created = await api.taskTrackerCreate(provider, {
        title: title.trim(),
        description: description.trim(),
        boardId: board.id,
        ...(board.projectId ? { projectId: board.projectId } : {}),
      });
      // The task exists now; a draft would only invite a duplicate.
      discard();
      if (images.length > 0) {
        // Upload before the agent starts so it sees the images on the task.
        // One image per request: ten 10 MB images in base64 would exceed the
        // server's 25 MB request body limit.
        try {
          for (const { name, mimeType, data } of images) await api.taskTrackerAttach(provider, created.id, [{ name, mimeType, data }]);
        } catch (cause) {
          taskTrackerHost()?.errors.show?.(friendly(tt("tasktrackers.work.imagesFailed", { key: created.key }), cause));
        }
      }
      let sessionId: string | undefined;
      if (startAgent && agentAvailable) {
        const [result] = await dispatchTasks(projectId!, [created]);
        if (result?.error) throw new Error(result.error);
        sessionId = result?.sessionId;
      }
      const task = created;
      setBusy(false);
      leave(() => onCreated(task, sessionId));
    } catch (cause) {
      setBusy(false);
      if (created) {
        // The task exists; only the agent start failed. Keep it visible.
        const task = created;
        taskTrackerHost()?.errors.show?.(friendly(tt("tasktrackers.work.agentFailed", { key: task.key }), cause));
        leave(() => onCreated(task));
        return;
      }
      // Only a lost answer to the write itself is ambiguous; the generic text
      // talks about sessions and drafts, which means nothing here.
      setError((cause as { mutationOutcome?: unknown } | null)?.mutationOutcome === "unknown"
        ? tt("tasktrackers.work.unknownCreate", { provider: PROVIDER_LABELS[provider], noun })
        : friendly(tt("tasktrackers.work.couldNotCreate"), cause));
    }
  };

  return (
    <aside
      ref={paneRef}
      className={`tt-compose-pane${leaving ? " is-leaving" : ""}`}
      aria-label={tt("tasktrackers.work.newTaskAria", { provider: PROVIDER_LABELS[provider], noun })}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (isImeComposing(event)) return;
        if (event.key === "Escape") close();
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "tt-compose-out") leaving?.();
      }}
    >
      <header className="tt-compose-head">
        <span className="tt-compose-context">
          <ProviderMark provider={provider} size="sm" />
          <span>{PROVIDER_LABELS[provider]}</span>
          <i aria-hidden="true">/</i>
          <b>{board.name}</b>
        </span>
        <IconButton icon={CloseIcon} size="sm" label={tt("tasktrackers.work.closeNewTask")} disabled={busy} onClick={close} />
      </header>
      <form
        className="tt-task-form"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          void addImages(files);
        }}
        noValidate
      >
        <div className="tt-compose-scroll">
          <div className="tt-compose-column">
            <h3 className="tt-compose-title">{tt("tasktrackers.work.newTask", { noun })}</h3>
            {error && <Notice tone="error">{error}</Notice>}
            <div
              className={`tt-compose-editor ui-field-well${dragging ? " is-dragging" : ""}`}
              onDragOver={(event) => {
                if (!hasFiles(event.nativeEvent)) return;
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={(event) => {
                if (!hasFiles(event.nativeEvent)) return;
                event.preventDefault();
                setDragging(false);
                void addImages([...event.dataTransfer.files]);
              }}
            >
              <TextInput
                className="tt-compose-name"
                value={title}
                autoFocus={finePointer}
                maxLength={255}
                placeholder={tt("tasktrackers.work.titlePlaceholder")}
                aria-label={tt("tasktrackers.work.title")}
                enterKeyHint="next"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  // Enter moves on to the details instead of submitting early.
                  if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
                  event.preventDefault();
                  detailsRef.current?.focus();
                }}
              />
              <Textarea
                ref={detailsRef}
                className="tt-compose-body"
                value={description}
                autoGrow
                minRows={4}
                maxRows={14}
                maxLength={20000}
                placeholder={tt("tasktrackers.work.detailsPlaceholder")}
                aria-label={tt("tasktrackers.work.taskDetails")}
                onChange={(event) => setDescription(event.target.value)}
              />
              {images.length > 0 && (
                <ul className="tt-compose-images" aria-label={tt("tasktrackers.work.imagesToAttach")}>
                  {images.map((image, index) => (
                    <li key={`${index}:${image.name}`}>
                      <img src={image.preview} alt={image.name} />
                      <IconButton
                        icon={CloseIcon}
                        size="sm"
                        label={tt("tasktrackers.work.removeImage", { name: image.name })}
                        disabled={busy}
                        onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <div className="tt-compose-tools">
                <Button
                  size="sm"
                  variant="ghost"
                  iconStart={ImageIcon}
                  disabled={busy || images.length >= IMAGES_MAX}
                  onClick={() => fileInput.current?.click()}
                >{tt("tasktrackers.work.addImages")}</Button>
                <span className="tt-compose-hint" aria-live="polite">
                  {dragging
                    ? tt("tasktrackers.work.dropToAttach")
                    : images.length > 0
                      ? tt("tasktrackers.work.imageCount", { count: images.length, max: IMAGES_MAX })
                      : finePointer ? tt("tasktrackers.work.dropOrPaste") : ""}
                </span>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                multiple
                hidden
                aria-label={tt("tasktrackers.work.chooseImages")}
                onChange={(event) => {
                  const files = [...event.target.files ?? []];
                  event.target.value = "";
                  void addImages(files);
                }}
              />
            </div>
            {canStartAgent && (
              <div className={`tt-compose-option${agentAvailable ? "" : " is-disabled"}`}>
                <span>
                  <strong id={agentLabelId}>{tt("tasktrackers.work.startAgentRightAway")}</strong>
                  <small>{agentAvailable
                    ? tt("tasktrackers.work.startAgentHint")
                    : tt("tasktrackers.work.openProjectForAgents")}</small>
                </span>
                <Switch
                  checked={startAgent && agentAvailable}
                  disabled={!agentAvailable || busy}
                  labelledBy={agentLabelId}
                  onChange={setStartAgent}
                />
              </div>
            )}
            {canStartAgent && startAgent && agentAvailable && <TaskStartOptionsFields projectId={projectId!} disabled={busy} />}
          </div>
        </div>
        <footer className="tt-compose-footer">
          <div className="tt-compose-column">
            <span className="tt-compose-shortcut" aria-hidden="true">
              <kbd className="kbd">{MOD}</kbd><kbd className="kbd">↵</kbd>
            </span>
            <Button variant="ghost" disabled={busy} onClick={cancel}>{tt("tasktrackers.work.cancel")}</Button>
            <Button
              type="submit"
              variant="primary"
              iconStart={startAgent && agentAvailable ? SendIcon : AddIcon}
              busy={busy}
              disabled={!title.trim() || busy}
            >
              {startAgent && agentAvailable ? tt("tasktrackers.work.createAndStart") : tt("tasktrackers.work.createTask")}
            </Button>
          </div>
        </footer>
      </form>
    </aside>
  );
}

/** Floating bar for the multi-select board mode: send many tasks at once. */
export function DispatchBar({
  tasks,
  projectId,
  onClear,
  onDone,
}: {
  tasks: readonly TaskTrackerTaskDto[];
  projectId: string | null;
  onClear: () => void;
  onDone: (results: TaskTrackerDispatchResultDto[]) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = tasks.length;

  const send = async () => {
    if (!projectId || count === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      onDone(await dispatchTasks(projectId, tasks, instructions));
      setInstructions("");
    } catch (cause) {
      setError(friendly(tt("tasktrackers.work.couldNotStartAgents"), cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tt-dispatch-bar" role="region" aria-label={tt("tasktrackers.work.sendSelected")}>
      <div className="tt-dispatch-row">
        <strong className="tt-dispatch-count" aria-live="polite">
          {count === 0 ? tt("tasktrackers.work.selectTasks") : tt("tasktrackers.work.selectedCount", { count })}
        </strong>
        <TextInput
          value={instructions}
          placeholder={tt("tasktrackers.work.instructionsPlaceholder")}
          aria-label={tt("tasktrackers.work.instructionsAria")}
          disabled={busy}
          onChange={(event) => setInstructions(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void send(); }}
        />
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>{tt("tasktrackers.work.cancel")}</Button>
        <Button
          size="sm"
          variant="primary"
          iconStart={SendIcon}
          busy={busy}
          disabled={!projectId || count === 0 || busy}
          onClick={() => void send()}
        >
          {count > 1 ? tt("tasktrackers.work.startAgents", { count }) : tt("tasktrackers.work.startAgent")}
        </Button>
      </div>
      {projectId && <TaskStartOptionsFields projectId={projectId} disabled={busy} />}
      <small className="tt-dispatch-hint">
        {projectId
          ? tt("tasktrackers.work.eachTaskSession")
          : tt("tasktrackers.work.openProjectForAgents")}
      </small>
      {error && <p className="tt-error" role="alert">{error}</p>}
    </div>
  );
}
