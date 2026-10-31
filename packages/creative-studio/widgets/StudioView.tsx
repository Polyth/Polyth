import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { SurfaceComponentProps, WebPackageHost } from "@polyth/web-sdk";
import {
  CREATIVE_STUDIO_PACKAGE_ID,
  currentStage,
  effectiveDuration,
  fmtTime,
  studioPaths,
  type QaFinding,
  type RenderJob,
  type StudioModelRef,
  type StudioModels,
  type StudioPatch,
  type StudioScene,
  type StudioState,
} from "../src/index.ts";
import { buildBrief, specToInit } from "../src/brief.ts";
import { createStudioClient, mediaUrl, type StudioClient, type StudioScope } from "./client.ts";
import { createPlayClock } from "./clock.ts";
import Dock, { type DockOutcome } from "./Dock.tsx";
import { ChatGlyph, CheckGlyph, ClapperGlyph, MoreGlyph, PlusGlyph, ExportGlyph, FilmGlyph, LayersGlyph, OpenGlyph, ProgressGlyph, ReviewGlyph, WaveGlyph } from "./glyphs.tsx";
import { MomentCard, Pipeline, StatusPill, type MomentActions } from "./Moment.tsx";
import Stage, { type StageControl, type StageRender } from "./Stage.tsx";
import ModelSettings from "./ModelSettings.tsx";
import { adoptable, afterPaint, pendingStarts, START_SEND_TIMEOUT_MS, type PendingStart } from "./start.ts";
import { fill, label, studioStrings, type StudioStrings } from "./strings.ts";
import {
  agentNotes,
  agentState,
  CONTINUE_REQUEST,
  fixRequest,
  isDelivered,
  latestDone,
  nextMoment,
  openFindings,
  sortedScenes,
  STUDIO_VIEWS,
  studioRequest,
  viewForStage,
  type StudioViewId,
} from "./studioModel.ts";
import Timeline from "./Timeline.tsx";
import { useStudio } from "./useStudio.ts";
import { ExportView, ProgressView, ReviewView, ScenesView, SoundView } from "./Views.tsx";
import Wizard, { type WizardResult } from "./Wizard.tsx";

export { viewForStage } from "./studioModel.ts";

/**
 * Point this project's chat draft at the studio's session model. A missing
 * route writes an explicit auto selection (never a fabricated model): the
 * composer drops a stale model when no harness is pinned, so switching back
 * to Auto cannot leave the chat stuck on the old route.
 */
function applySessionModel(host: WebPackageHost, projectId: string, route: StudioModelRef | undefined): void {
  if (!route) {
    host.executionDraft.update(projectId, { harnessSelection: { mode: "auto" }, harnessSelectionExplicit: true });
    return;
  }
  host.executionDraft.update(projectId, {
    harnessSelection: { mode: "pinned", harnessId: route.harnessId },
    harnessSelectionExplicit: true,
    model: {
      harnessId: route.harnessId,
      providerID: route.providerID,
      modelID: route.modelID,
      ...(route.variant ? { variant: route.variant } : {}),
    },
  });
}

interface Props extends SurfaceComponentProps { host: WebPackageHost }

type SetupStepId = "chat" | "song" | "lyrics" | "brief";
interface SetupStep { id: SetupStepId; status: "pending" | "active" | "done" | "failed" }

/** The view a studio opens on before the person picks one. */
function defaultView(state: StudioState): StudioViewId {
  if (state.scenes.length) return state.stages.export.status === "done" || state.renders.some((job) => job.kind === "final" && job.status === "running") ? "export" : "scenes";
  if (!state.audio?.analyzedAt) return "sound";
  return viewForStage(currentStage(state));
}

const VIEW_GLYPHS = { scenes: FilmGlyph, sound: WaveGlyph, export: ExportGlyph, review: ReviewGlyph, progress: ProgressGlyph } as const;

export default function StudioView({ host, projectId: scopedProjectId, sessionId: scopedSessionId, active }: Props) {
  const snapshot = useSyncExternalStore(host.store.subscribe, host.store.getSnapshot, host.store.getSnapshot);
  const projectId = scopedProjectId === undefined ? snapshot.activeProjectId : scopedProjectId;
  const sessionId = scopedSessionId === undefined ? snapshot.activeSessionId : scopedSessionId;
  // Re-render on this session's status/attention/usage only: a primitive
  // snapshot, so an unstable projection object cannot loop the store.
  useSyncExternalStore(host.sessions.subscribe, () => {
    const current = sessionId ? host.sessions.get(sessionId) : undefined;
    return current
      ? `${current.status}|${current.attention?.questions ?? 0}|${current.attention?.permissions ?? 0}|${current.tokenTotals?.input ?? 0}|${current.tokenTotals?.output ?? 0}|${current.costTotal ?? 0}|${current.createdAt}`
      : "";
  }, () => "");
  const session = sessionId ? host.sessions.get(sessionId) : undefined;
  const agent = agentState(session);
  const t = studioStrings(host.ui.locale.get());
  const client = useMemo(() => createStudioClient(), []);
  const scope: StudioScope | null = useMemo(() => (projectId && sessionId ? { projectId, sessionId } : null), [projectId, sessionId]);
  const studio = useStudio(client, scope, {
    active: active !== false,
    working: agent === "working" || agent === "needs-you",
    friendly: (action, cause) => host.errors.friendly(action, cause),
    loadFailed: t.loadFailed,
  });
  const pending = useSyncExternalStore(pendingStarts.subscribe, () => pendingStarts.get(projectId), () => null);
  const isHome = snapshot.workbenchProfile === CREATIVE_STUDIO_PACKAGE_ID;

  const [setup, setSetup] = useState<SetupStep[] | null>(null);
  const [startError, setStartError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // Reveal the studio's own conversation. As the lane's home the studio
  // covers it; closing the window shows it beneath (the profile stays).
  const openConversation = useCallback(() => {
    if (snapshot.railPlugin === CREATIVE_STUDIO_PACKAGE_ID) host.navigation.closeWorkspacePane();
    else host.workbench.openSurface("session");
  }, [host, snapshot.railPlugin]);

  const newVideo = useCallback(() => {
    if (!projectId) return;
    if (!isHome) host.workbench.activateProfile(CREATIVE_STUDIO_PACKAGE_ID);
    host.conversation.startNewSession(projectId);
  }, [host, isHome, projectId]);

  // ------------------------------------------------------------ start

  /** Create the studio in an existing chat, add the song and lyrics, then
   * brief the agent. `brief` null = the brief already started this chat;
   * a string is an expert's edited brief, sent as written. */
  const runSetup = useCallback(async (target: StudioScope, start: Pick<PendingStart, "spec" | "song" | "lyricsFile" | "lyricsText">, brief: string | "generate" | null) => {
    const hasLyrics = Boolean(start.lyricsFile || start.lyricsText.trim());
    const sendBrief = brief !== null;
    const steps: SetupStep[] = [
      ...(sendBrief ? [] : [{ id: "chat" as const, status: "done" as const }]),
      ...(start.song ? [{ id: "song" as const, status: "pending" as const }] : []),
      ...(hasLyrics ? [{ id: "lyrics" as const, status: "pending" as const }] : []),
      { id: "brief", status: sendBrief ? "pending" : "done" },
    ];
    const mark = (id: SetupStepId, status: SetupStep["status"]) => {
      const index = steps.findIndex((step) => step.id === id);
      if (index >= 0) steps[index] = { id, status };
      setSetup([...steps]);
    };
    setSetup([...steps]);
    setStartError("");
    const spec = { ...start.spec };
    try {
      await client.init(target, specToInit(spec));
      if (start.song) {
        mark("song", "active");
        spec.audioPath = (await client.upload(target, start.song)).path;
        mark("song", "done");
      }
      if (hasLyrics) {
        mark("lyrics", "active");
        const file = start.lyricsFile ?? new File([start.lyricsText], "lyrics.txt", { type: "text/plain" });
        spec.lyricsPath = (await client.upload(target, file)).path;
        mark("lyrics", "done");
      }
      if (sendBrief) {
        mark("brief", "active");
        const text = brief === "generate" ? buildBrief(spec, { studioId: target.sessionId }) : brief;
        const sent = await host.conversation.send(target.sessionId, text);
        if (!sent) throw new Error(t.dockFailed);
        mark("brief", "done");
      }
      await studio.refresh().catch(() => undefined);
      setSetup(null);
    } catch (cause) {
      const failed = steps.find((step) => step.status === "active");
      if (failed) mark(failed.id, "failed");
      setStartError(host.errors.friendly(t.actionFailed, cause));
    }
  }, [client, host, studio, t.actionFailed, t.dockFailed]);

  const start = useCallback((result: WizardResult) => void (async () => {
    if (!projectId) return;
    setBusy("start");
    try {
      // The session model is a chat-level choice: apply it to the draft
      // execution config the composer sends with (a new chat materialises the
      // canonical session from it; an existing chat switches on the next turn).
      applySessionModel(host, projectId, result.spec.models.default);
      if (scope) {
        // The chat exists: set the studio up, then brief the agent with paths.
        await runSetup(scope, { spec: result.spec, song: result.song, lyricsFile: result.lyricsFile, lyricsText: result.lyricsText }, result.brief ?? "generate");
        return;
      }
      // No chat yet: the brief creates it through the composer; the song
      // follows as soon as the studio sees the new chat.
      const brief = result.brief ?? buildBrief(result.spec, {
        uploading: { song: Boolean(result.song), lyrics: Boolean(result.lyricsFile || result.lyricsText.trim()) },
      });
      pendingStarts.set({ projectId, at: Date.now(), spec: result.spec, song: result.song, lyricsFile: result.lyricsFile, lyricsText: result.lyricsText, phase: "seeding" });
      host.conversation.startNewSession(projectId, { title: result.spec.idea.trim().slice(0, 60), draft: brief });
      await afterPaint();
      const submitted = host.conversation.submitDraft?.() ?? false;
      if (submitted) pendingStarts.update({ phase: "submitted" });
      else {
        pendingStarts.update({ phase: "manual" });
        host.navigation.closeWorkspacePane();
      }
    } catch (cause) {
      setStartError(host.errors.friendly(t.actionFailed, cause));
    } finally {
      setBusy(null);
    }
  })(), [host, projectId, runSetup, scope, t.actionFailed]);

  // Adopt the chat a seeded brief created: upload the song into its checkout.
  const adopting = useRef<string | null>(null);
  useEffect(() => {
    if (!scope || !pending || studio.loading || studio.state || adopting.current === scope.sessionId) return;
    if (!adoptable(pending, session, false)) return;
    adopting.current = scope.sessionId;
    pendingStarts.clear();
    void runSetup(scope, pending, null);
  }, [scope, pending, session, studio.loading, studio.state, runSetup]);

  // A submitted brief that produced no chat hands over to the conversation.
  useEffect(() => {
    if (!pending || pending.phase !== "submitted" || scope) return;
    const timer = window.setTimeout(() => pendingStarts.update({ phase: "manual" }), Math.max(0, pending.at + START_SEND_TIMEOUT_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pending, scope]);

  // ------------------------------------------------------------ routes

  const { EmptyState } = host.ui.components;
  if (!projectId) {
    return <div className="creative-studio"><div className="cs-center"><EmptyState title={t.title} description={t.noProject} /></div></div>;
  }
  if (setup || (pending && !scope)) {
    return (
      <div className="creative-studio">
        <SetupScreen
          host={host}
          t={t}
          steps={setup ?? [{ id: "chat", status: pending?.phase === "manual" ? "failed" : "active" }, { id: "brief", status: "pending" }]}
          manual={!setup && pending?.phase === "manual"}
          error={startError}
          onOpenConversation={openConversation}
          onCancel={() => { pendingStarts.clear(); setSetup(null); setStartError(""); }}
        />
      </div>
    );
  }
  // Re-entering the lane opens its remembered video a moment after the studio
  // shows; until then this is loading, not a new video.
  const reopening = !scope && isHome && Boolean(host.workbench.getProfileSession?.(CREATIVE_STUDIO_PACKAGE_ID));
  if ((studio.loading && !studio.state) || reopening) {
    return <div className="creative-studio" aria-busy="true"><StudioSkeleton t={t} /></div>;
  }
  if (!studio.state || !scope) {
    return (
      <div className="creative-studio creative-studio--create">
        {studio.error && <p className="cs-error cs-banner" role="alert">{studio.error}</p>}
        <Wizard host={host} sessionId={scope ? scope.sessionId : null} busy={busy === "start"} error={startError} onStart={start} />
      </div>
    );
  }
  return (
    <Studio
      key={studio.state.id}
      host={host}
      t={t}
      client={client}
      scope={scope}
      state={studio.state}
      studio={studio}
      session={session}
      agent={agent}
      active={active !== false}
      isHome={isHome}
      onOpenConversation={openConversation}
      onNewVideo={newVideo}
    />
  );
}

// ----------------------------------------------------------------- studio

interface StudioProps {
  host: WebPackageHost;
  t: StudioStrings;
  client: StudioClient;
  scope: StudioScope;
  state: StudioState;
  studio: ReturnType<typeof useStudio>;
  session: ReturnType<WebPackageHost["sessions"]["get"]>;
  agent: ReturnType<typeof agentState>;
  active: boolean;
  isHome: boolean;
  onOpenConversation(): void;
  onNewVideo(): void;
}

function Studio({ host, t, client, scope, state, studio, session, agent, active, isHome, onOpenConversation, onNewVideo }: StudioProps) {
  const { IconButton, Menu, Tabs, Button } = host.ui.components;
  const Dialog = host.ui.Dialog;
  const clock = useMemo(() => createPlayClock(), []);
  const control = useRef<StageControl | null>(null);
  const scenes = useMemo(() => sortedScenes(state), [state]);
  const [view, setView] = useState<StudioViewId | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dockScope, setDockScope] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [render, setRender] = useState<{ job: RenderJob } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [modelsOpen, setModelsOpen] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // Follow the agent: the open view tracks the stage until the person picks one.
  const liveStage = currentStage(state);
  const lastStage = useRef(liveStage);
  useEffect(() => {
    if (lastStage.current !== liveStage) { lastStage.current = liveStage; setView(null); }
  }, [liveStage]);
  const shownView = view ?? defaultView(state);

  const run = useCallback(async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try { await work(); } catch (cause) { setError(host.errors.friendly(t.actionFailed, cause)); } finally { setBusy(null); }
  }, [host.errors, t.actionFailed]);

  const patch = useCallback(async (value: StudioPatch) => {
    studio.accept((await client.patch(scope, value)).state);
  }, [client, scope, studio]);

  const media = useCallback((path: string, version?: string | number) => mediaUrl(scope, path, version), [scope]);
  const stillUrl = useCallback((scene: StudioScene) => scene.stillRevision ? media(studioPaths(state.id).still(scene.id), scene.stillRevision) : null, [media, state.id]);
  const audioUrl = state.audio?.path ? media(state.audio.path) : null;

  const send = useCallback(async (text: string): Promise<DockOutcome> => {
    const busyNow = agent === "working" || agent === "needs-you";
    const ok = await host.conversation.send(scope.sessionId, text, { delivery: busyNow ? "queue" : "normal" });
    return ok ? (busyNow ? "queued" : "sent") : false;
  }, [agent, host.conversation, scope.sessionId]);

  const seek = useCallback((time: number, play = false) => control.current?.seek(time, { play }), []);
  // On a phone the studio scrolls as one page: a seek that starts in a view
  // (a timestamp, Play from here) brings the player back into sight.
  const studioRef = useRef<HTMLDivElement>(null);
  const revealStage = useCallback(() => {
    const root = studioRef.current;
    const stage = root?.querySelector<HTMLElement>(".cs-stage");
    if (!root || !stage || root.scrollHeight <= root.clientHeight + 1) return;
    const offset = stage.getBoundingClientRect().top - root.getBoundingClientRect().top;
    if (offset >= -1) return;
    const reduce = document.documentElement.dataset.reduceAnimations === "true"
      || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    root.scrollTo?.({ top: Math.max(0, root.scrollTop + offset - 8), behavior: reduce ? "auto" : "smooth" });
  }, []);
  const seekAndShow = useCallback((time: number, play = false) => { seek(time, play); revealStage(); }, [revealStage, seek]);
  const selectScene = useCallback((scene: StudioScene) => {
    setSelected((current) => (current === scene.id ? null : scene.id));
    if (selected !== scene.id) seek(scene.start);
  }, [seek, selected]);

  const upload = useCallback((file: File) => void run("upload", async () => {
    const uploaded = await client.upload(scope, file);
    // A new song is analyzed right away; new lyrics re-time against the current song.
    if (uploaded.kind === "audio" || state.audio) await client.analyze(scope);
    await studio.refresh();
  }), [client, run, scope, state.audio, studio]);

  const analyze = useCallback(() => void run("analyze", async () => {
    await client.analyze(scope);
    await studio.refresh();
  }), [client, run, scope, studio]);

  const renderKind = useCallback((kind: "stills" | "preview" | "final") => void run("render", async () => {
    await client.render(scope, kind);
    await studio.refresh();
  }), [client, run, scope, studio]);

  const cancel = useCallback(() => void run("cancel", async () => {
    await client.cancel(scope);
    await studio.refresh();
  }), [client, run, scope, studio]);

  const openFile = useCallback((path: string) => {
    host.navigation.openResource({ scheme: "file", locator: path, projectId: scope.projectId, sessionId: scope.sessionId });
  }, [host.navigation, scope]);

  const dismiss = useCallback((finding: QaFinding) => void run("dismiss", () => patch({ findings: [{ id: finding.id, status: "dismissed" }] })), [patch, run]);
  const askFix = useCallback((finding: QaFinding) => void run("fix", async () => {
    const scene = state.scenes.find((candidate) => candidate.id === finding.sceneId);
    const where = scene ? `${scene.id}, ${fmtTime(finding.time ?? scene.start)}` : undefined;
    const outcome = await send(fixRequest(finding.message, where));
    if (!outcome) throw new Error(t.dockFailed);
  }), [run, send, state.scenes, t.dockFailed]);

  const changeScene = useCallback((scene: StudioScene) => {
    setDockScope(scene.id);
    setSelected(scene.id);
    setFocusRequest((value) => value + 1);
  }, []);

  const watch = useCallback((job: RenderJob) => {
    if (!job.output) return;
    setRender({ job });
    revealStage();
  }, [revealStage]);

  // Later model changes: keep the studio state in sync and, for the session
  // route, move the chat draft so the next turn runs on the chosen model.
  const saveModels = useCallback((models: StudioModels) => {
    applySessionModel(host, scope.projectId, models.default);
    void patch({ models, activity: [{ role: "user", message: t.modelsChanged, stage: currentStage(state) }] });
  }, [host, patch, scope.projectId, state, t.modelsChanged]);

  const final = latestDone(state, "final");
  const momentActions: MomentActions = {
    openConversation: onOpenConversation,
    approve: () => void run("approve", async () => {
      await patch({ approve: "concept", activity: [{ role: "user", message: t.approved, stage: "concept" }] });
      await host.conversation.send(scope.sessionId, t.approveMessage);
    }),
    requestChanges: () => { setDockScope(null); setFocusRequest((value) => value + 1); },
    stopRender: cancel,
    watch: () => { if (final) watch(final); },
    openFinal: () => { if (final?.output) openFile(final.delivered ?? final.output); },
    review: () => setView("review"),
    askFix: () => void run("fix", async () => {
      const failed = state.renders.at(-1);
      const outcome = await send(fixRequest(failed?.error || "The last step did not finish."));
      if (!outcome) throw new Error(t.dockFailed);
    }),
    continueWork: () => void run("continue", async () => {
      const outcome = await send(CONTINUE_REQUEST);
      if (!outcome) throw new Error(t.dockFailed);
    }),
  };

  const moment = nextMoment(state, agent);
  const delivered = isDelivered(state);
  const viewsId = `cs-views-${state.id.slice(0, 8)}`;
  const scopeScene = dockScope ? scenes.find((scene) => scene.id === dockScope) : undefined;
  const findingsOpen = openFindings(state).length;
  const notes = useAgentNotes(host, scope.sessionId, shownView === "progress");
  const tokens = session?.tokenTotals ? session.tokenTotals.input + session.tokenTotals.output : undefined;
  const meta = [
    state.mediaKind ? label(t, `kind_${state.mediaKind}`) : null,
    label(t, `aspect_${state.format.aspect.replace(":", "_")}`),
    fmtClock(effectiveDuration(state)),
    state.audio?.bpm ? `${Math.round(state.audio.bpm)} BPM` : null,
  ].filter(Boolean).join(" · ");

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.key !== " " || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a, [role=slider], [contenteditable=true], video")) return;
    event.preventDefault();
    control.current?.toggle();
  };

  const stageRender: StageRender | null = render?.job.output
    ? { url: media(render.job.output, render.job.finishedAt), label: fill(t.playingRender, { kind: label(t, `render_${render.job.kind}`) }) }
    : null;

  return (
    <div className="creative-studio" data-agent={agent} data-home={isHome || undefined} onKeyDown={onKeyDown}>
      <div className="cs-studio" ref={studioRef} data-aspect={state.format.aspect}>
        <header className="cs-top">
          <div className="cs-top-title">
            <h2 dir="auto">{state.title}</h2>
            <span className="cs-top-meta">{meta}</span>
          </div>
          <StatusPill t={t} agent={agent} delivered={delivered} yourTurn={moment?.kind === "approve"} />
          <Menu
            label={t.menuLabel}
            align="end"
            entries={[
              { id: "conversation", label: t.menuConversation, icon: ChatGlyph, onSelect: onOpenConversation },
              { id: "new", label: t.menuNewVideo, icon: PlusGlyph, onSelect: onNewVideo },
              { id: "models", label: t.menuModels, icon: LayersGlyph, onSelect: () => setModelsOpen(true) },
              ...(final?.output ? [{ id: "final", label: t.menuFinal, icon: OpenGlyph, onSelect: () => openFile(final.delivered ?? final.output!) }] : []),
              { id: "files", label: t.menuFiles, icon: ClapperGlyph, onSelect: () => host.navigation.revealResource({ scheme: "file", locator: studioPaths(state.id).state, projectId: scope.projectId, sessionId: scope.sessionId }) },
            ]}
          >
            {(trigger: Record<string, unknown>) => <IconButton icon={MoreGlyph} label={t.menuLabel} variant="ghost" size="md" {...trigger} />}
          </Menu>
        </header>
        <Pipeline t={t} state={state} agent={agent} onOpen={() => setView("progress")} />
        <Stage
          host={host}
          t={t}
          client={client}
          state={state}
          scenes={scenes}
          analysis={studio.analysis}
          codes={studio.codes}
          audioUrl={audioUrl}
          clock={clock}
          controlRef={control}
          stillUrl={stillUrl}
          active={active}
          live={agent === "working"}
          render={stageRender}
          onBackToLive={() => setRender(null)}
          onShowErrors={() => setView("review")}
        />
        <Timeline
          t={t}
          state={state}
          scenes={scenes}
          analysis={studio.analysis}
          clock={clock}
          selectedScene={selected}
          stillUrl={stillUrl}
          onSeek={seek}
          onSelectScene={(id) => setSelected(id)}
        />
        <div className="cs-panel">
          {(error || studio.error) && <p className="cs-error cs-banner" role="alert">{error || studio.error}</p>}
          {moment && <MomentCard host={host} t={t} moment={moment} busy={busy} actions={momentActions} />}
          <div className="cs-views-bar ui-glass-dock">
          <Tabs
            className="cs-views"
            size="sm"
            idBase={viewsId}
            label={t.viewsLabel}
            value={shownView}
            tabs={STUDIO_VIEWS.map((id) => {
              const Glyph = VIEW_GLYPHS[id];
              const count = id === "review" ? findingsOpen : 0;
              return { id, label: <span className="cs-view-tab"><Glyph className="cs-view-glyph" />{label(t, `view_${id}`)}{count > 0 && <span className="cs-count">{count}</span>}{id === "export" && delivered && <CheckGlyph className="cs-view-done" />}</span> };
            })}
            onChange={(value: string) => setView(value as StudioViewId)}
          />
          </div>
          <div className="cs-panel-body" key={shownView} role="tabpanel" id={`${viewsId}-panel-${shownView}`} aria-labelledby={`${viewsId}-tab-${shownView}`}>
            {shownView === "scenes" && (
              <ScenesView host={host} t={t} state={state} scenes={scenes} stillUrl={stillUrl} selected={selected} onSelect={selectScene} onPlayFrom={(scene) => { setRender(null); seekAndShow(scene.start, true); }} onChange={changeScene} />
            )}
            {shownView === "sound" && (
              <SoundView host={host} t={t} state={state} analysis={studio.analysis} busy={busy === "upload" || busy === "analyze"} onUpload={upload} onAnalyze={analyze} onSeek={(time) => seekAndShow(time)} />
            )}
            {shownView === "export" && (
              <ExportView host={host} t={t} state={state} now={now} busy={busy === "render"} mediaUrl={media} onRender={renderKind} onCancel={cancel} onOpen={openFile} onWatch={watch} />
            )}
            {shownView === "review" && (
              <ReviewView host={host} t={t} state={state} mediaUrl={media} onDismiss={dismiss} onAskFix={askFix} onSeek={(time) => seekAndShow(time)} />
            )}
            {shownView === "progress" && (
              <ProgressView
                t={t}
                state={state}
                now={now}
                notes={notes}
                focus={liveStage}
                {...(tokens !== undefined ? { tokens } : {})}
                {...(session?.costTotal !== undefined ? { cost: session.costTotal } : {})}
              />
            )}
          </div>
        </div>
        <Dock
          host={host}
          t={t}
          working={agent === "working"}
          scope={scopeScene ? { scene: scopeScene, index: scenes.indexOf(scopeScene) } : null}
          focusRequest={focusRequest}
          onClearScope={() => setDockScope(null)}
          onSend={async (text) => {
            const outcome = await send(studioRequest(text, scopeScene ?? null));
            if (outcome) {
              setDockScope(null);
              void patch({ activity: [{ role: "user", message: text.slice(0, 280), ...(scopeScene ? { sceneId: scopeScene.id } : {}) }] }).catch(() => undefined);
            }
            return outcome;
          }}
        />
        {modelsOpen && (
          <Dialog title={t.modelSectionTitle} onClose={() => setModelsOpen(false)} size="lg">
            <p className="cs-hint">{t.modelSectionHint}</p>
            <ModelSettings
              projectId={scope.projectId}
              expert
              value={state.models ?? {}}
              onChange={saveModels}
              strings={t}
              expertIntro={<div className="cs-field"><span className="cs-field-label">{t.modelExpertHeading}</span><p className="cs-field-hint">{t.modelExpertSub}</p></div>}
            />
            <div className="cs-row cs-row--split">
              <Button variant="primary" onClick={() => setModelsOpen(false)}>{t.modelsDone}</Button>
            </div>
          </Dialog>
        )}
      </div>
    </div>
  );
}

const fmtClock = (seconds: number) => {
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};

/** The agent's replies, read only while the Progress view shows them: a scan
 * per streamed chunk would cost a full history pass each time. */
function useAgentNotes(host: WebPackageHost, sessionId: string, enabled: boolean) {
  const key = useSyncExternalStore(host.sessions.subscribe, () => {
    if (!enabled) return 0;
    const events = host.sessions.events(sessionId);
    for (let index = events.length - 1; index >= 0; index--) if (events[index]!.type === "assistant/message") return events[index]!.seq;
    return 0;
  }, () => 0);
  return useMemo(() => (enabled ? agentNotes(host.sessions.events(sessionId)) : []), [enabled, host.sessions, key, sessionId]);
}

// ---------------------------------------------------------- setup screens

function SetupScreen({ host, t, steps, manual, error, onOpenConversation, onCancel }: {
  host: WebPackageHost; t: StudioStrings; steps: readonly SetupStep[]; manual: boolean; error: string;
  onOpenConversation(): void; onCancel(): void;
}) {
  const { Button } = host.ui.components;
  return (
    <div className="cs-center">
      <section className="cs-setup" aria-live="polite">
        <span className="cs-setup-mark" aria-hidden="true"><ClapperGlyph /></span>
        <h2>{t.setupTitle}</h2>
        <ol className="cs-setup-steps">
          {steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              <span className="cs-setup-dot" aria-hidden="true">{step.status === "done" ? <CheckGlyph /> : null}</span>
              <span>{label(t, `setup_${step.id}`)}</span>
            </li>
          ))}
        </ol>
        {manual && <p className="cs-hint">{t.setupManual}</p>}
        {error && <p className="cs-error" role="alert">{error}</p>}
        {(manual || error) && (
          <div className="cs-row">
            <Button variant="primary" iconStart={ChatGlyph} onClick={onOpenConversation}>{t.openConversation}</Button>
            <Button variant="ghost" onClick={onCancel}>{t.setupCancel}</Button>
          </div>
        )}
      </section>
    </div>
  );
}

function StudioSkeleton({ t }: { t: StudioStrings }) {
  return (
    <div className="cs-skeleton" role="status" aria-label={t.loading}>
      <span className="cs-skel cs-skel-title" />
      <span className="cs-skel cs-skel-line" />
      <span className="cs-skel cs-skel-stage" />
      <span className="cs-skel cs-skel-film" />
      <span className="cs-skel cs-skel-line" />
    </div>
  );
}
