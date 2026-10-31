// Terminal pane: tabs of real shells over /ws/terminal/:id. Each tab owns a
// TerminalEmulator instance (VT parser + cell grid, src/terminal/emulator.ts)
// that lives OUTSIDE React state — WS frames feed it directly and TermPane
// subscribes for coalesced repaints. Replay frames rebuild the emulator from
// scratch so reconnects never duplicate output.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { TerminalInfo } from "@polyth/contracts";
import { resolveWorkspaceContext, workspaceExecutionPath } from "@polyth/contracts/workspace";
import type { SurfaceComponentProps } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import { useStore, workspacePresentationKey, workspaceProjectId } from "../../../apps/web/src/store.ts";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../../../apps/web/src/projectPresentationSync.ts";
import { nextTermBackoff } from "../../../apps/web/src/utils.ts";
import { usePaneVisible } from "../../../apps/web/src/workspace/paneVisibility.ts";
import { createTerminalEmulator, type TerminalEmulator } from "./terminal/emulator.ts";
import { restoreTerminalReplay } from "./terminal/replay.ts";
import { measureTerminalGrid } from "./terminal/measurement.ts";
import { useTouchPrefs } from "./terminal/touchPrefs.ts";
import EmptyState, { ProjectRequiredEmpty } from "../../../apps/web/src/components/EmptyState.tsx";
import TermPane from "./TermPane.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  AddIcon,
  CloseIcon,
  DeleteIcon,
  IconButton,
  RepositoryScopePicker,
  SearchIcon,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

function connectionLabel(connection: ConnectionState): string {
  if (connection === "connected") return tr("terminalview.connected");
  if (connection === "reconnecting") return tr("terminalview.reconnecting");
  if (connection === "connecting") return tr("terminalview.connecting");
  return tr("terminalview.disconnected");
}

interface Tab {
  id: string;
  title: string;
  running: boolean;
  exitCode?: number | null;
  connection: ConnectionState;
  customTitle?: boolean;
  sessionId?: string;
  repositoryId?: string;
  workspace?: TerminalInfo["workspace"];
}

function wsUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/terminal/${id}`;
}

/** Theme color for OSC 10/11 queries (apps probe bg to pick dark/light). */
function themeVar(name: string): string | undefined {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const terminalRepositoryKey = (projectId: string, sessionId?: string | null): string =>
  workspacePresentationKey("terminal-repository", projectId, sessionId ?? null);

const EMPTY_REPOSITORIES: readonly [] = [];

function readTerminalRepositorySelection(projectId: string, sessionId?: string | null): string | null | undefined {
  try {
    const value = localStorage.getItem(terminalRepositoryKey(projectId, sessionId));
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writeTerminalRepositorySelection(projectId: string, sessionId: string | null | undefined, repositoryId: string | null): void {
  try {
    const key = terminalRepositoryKey(projectId, sessionId);
    if (repositoryId) localStorage.setItem(key, repositoryId);
    else localStorage.removeItem(key);
    markProjectPresentationChanged(projectId, "workspaceState");
  } catch { /* best effort */ }
}

export default function TerminalView({
  projectId: scopedProjectId,
  sessionId: scopedSessionId,
}: SurfaceComponentProps) {
  const storeProjectId = useStore(workspaceProjectId);
  const storeSessionId = useStore((s) => s.activeSessionId);
  const projectId = scopedProjectId === undefined ? storeProjectId : scopedProjectId;
  const sessionId = scopedSessionId === undefined ? storeSessionId : scopedSessionId;
  const project = useStore((s) => s.projectRegistry.projects.find((candidate) => candidate.id === projectId) ?? null);
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const workspace = useMemo(() => {
    if (!project) return null;
    try { return resolveWorkspaceContext(project, session); } catch { return null; }
  }, [project, session]);
  const sessionExecutionRepositoryId = useMemo(() => {
    if (!project || !session || !workspace) return undefined;
    try {
      const executionPath = workspaceExecutionPath(project, session);
      return workspace.repositories.find((repository) => repository.path === executionPath)?.repositoryId;
    } catch {
      return undefined;
    }
  }, [project, session, workspace]);
  const workspaceInvalid = project !== null && (
    workspace === null
    || (sessionId !== null && sessionId !== undefined && session === null)
    || (session !== null && sessionExecutionRepositoryId === undefined)
  );
  // Keep the empty fallback stable. The generated-title callback is used by
  // the adoption effect; a fresh [] here would retrigger that effect forever
  // while a project/session is still unresolved.
  const repositoryRows = workspace?.repositories ?? EMPTY_REPOSITORIES;
  const repositoryRowsRef = useRef(repositoryRows);
  repositoryRowsRef.current = repositoryRows;
  const repositoryOptions = repositoryRows.map((repository) => ({
    id: repository.repositoryId,
    alias: repository.alias,
    detail: repository.state === "missing" ? tr("terminalview.repositoryMissing", { path: repository.path }) : repository.path,
  }));
  const primaryRepositoryId = project?.primaryRepositoryId
    ?? repositoryRows.find((repository) => repository.path === project?.path)?.repositoryId
    ?? (repositoryRows.length === 1 ? repositoryRows[0]?.repositoryId : undefined);
  const [storedRepositoryId, setStoredRepositoryId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setStoredRepositoryId(projectId ? readTerminalRepositorySelection(projectId, sessionId) : undefined);
  }, [projectId, sessionId]);
  useEffect(() => {
    const onHydrated = (event: Event): void => {
      if (!projectId || projectPresentationEventProjectId(event) !== projectId || !projectPresentationEventHasKey(event, "workspaceState")) return;
      setStoredRepositoryId(readTerminalRepositorySelection(projectId, sessionId));
    };
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }, [projectId, sessionId]);
  const selectedRepositoryId = storedRepositoryId && repositoryRows.some((repository) => repository.repositoryId === storedRepositoryId)
    ? storedRepositoryId
    : session
      ? sessionExecutionRepositoryId
      : repositoryRows.length > 1 ? null : (primaryRepositoryId ?? repositoryRows[0]?.repositoryId);
  const selectedRepository = repositoryRows.find((repository) => repository.repositoryId === selectedRepositoryId) ?? null;
  const chooseRepository = (next: string | null) => {
    if (!projectId) return;
    setStoredRepositoryId(next);
    writeTerminalRepositorySelection(projectId, sessionId, next);
  };
  const generatedTerminalTitle = useCallback((terminal: Pick<TerminalInfo, "repositoryId" | "workspace" | "cwd">): string => {
    if (terminal.workspace?.kind === "composite") return "Workspace · shell";
    const repository = repositoryRowsRef.current.find((row) => row.repositoryId === terminal.repositoryId);
    return repository ? `${repository.alias} · shell` : (terminal.cwd.split(/[\\/]/).pop() || tr("terminalview.shellValue", { value: 1 }));
  }, []);
  const visible = usePaneVisible();
  // Pinch zoom is a per-device override of Appearance › Terminal font size.
  const { fontSize: zoomedFontSize } = useTouchPrefs();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [searchSignal, setSearchSignal] = useState(0);
  // One-click terminal (finding 6): listLoaded flips true once the adopt fetch
  // below answered for the CURRENT project, so auto-spawn never fires on the
  // not-yet-known empty state. autoSpawnArmed re-arms on every hidden→visible
  // transition (and project switch) and is spent on first sight of a loaded
  // list — closing the last tab while the pane stays open must NOT respawn it.
  const [listLoaded, setListLoaded] = useState(false);
  const autoSpawnArmed = useRef(true);
  const sockets = useRef(new Map<string, WebSocket>());
  // One emulator per terminal id — kept in a ref so background tabs keep
  // ingesting output and scrollback survives tab switches.
  const emus = useRef(new Map<string, TerminalEmulator>());
  const replaying = useRef(new Set<string>());
  // Reconnect state: per-terminal backoff + pending timers; `gone` marks
  // terminals we closed deliberately (or the server reported missing) so the
  // reconnect loop stops instead of resurrecting them.
  const backoffs = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const gone = useRef(new Set<string>());
  const mounted = useRef(true);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  // Preserve input ordering while a socket connects/reconnects. The old REST
  // fallback launched one asynchronous request per key and could reorder fast
  // typing; one bounded queue flushes atomically when the WS is healthy.
  const pendingInput = useRef(new Map<string, string>());
  // last measured grid, reused when spawning so new PTYs start near-correct
  const lastSize = useRef({ cols: 120, rows: 32 });
  const initialBodyRef = useRef<HTMLDivElement>(null);
  const initialProbeRef = useRef<HTMLSpanElement>(null);

  const sendTo = useCallback((id: string, data: string) => {
    const ws = sockets.current.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    } else {
      const queued = (pendingInput.current.get(id) ?? "") + data;
      pendingInput.current.set(id, queued.length > 64 * 1024 ? queued.slice(-64 * 1024) : queued);
    }
  }, []);

  const getEmu = useCallback((id: string): TerminalEmulator => {
    let emu = emus.current.get(id);
    if (!emu) {
      emu = createTerminalEmulator({
        cols: lastSize.current.cols,
        rows: lastSize.current.rows,
        scrollback: document.body.dataset.desktopLowResource === "true" ? 1000 : 5000,
        queryFg: themeVar("--term-fg"),
        queryBg: themeVar("--term-bg"),
      });
      // DSR/DA/CPR replies go straight back to the PTY
      emu.onResponse((data) => {
        if (!replaying.current.has(id)) sendTo(id, data);
      });
      let lastTitle = "";
      emu.onUpdate(() => {
        const next = emu?.title() ?? "";
        if (!next || next === lastTitle) return;
        lastTitle = next;
        setTabs((prev) => prev.map((tab) =>
          tab.id === id && !tab.customTitle ? { ...tab, title: next.slice(0, 80) } : tab));
      });
      emus.current.set(id, emu);
    }
    return emu;
  }, [sendTo]);

  const dropTab = (id: string) => {
    emus.current.delete(id);
    pendingInput.current.delete(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActive((a) => (a === id ? next[0]?.id ?? null : a));
      return next;
    });
  };

  const attach = (id: string) => {
    const attachedProject = projectRef.current;
    if (!mounted.current || !attachedProject || sockets.current.has(id) || gone.current.has(id)) return;
    const ws = new WebSocket(wsUrl(id));
    sockets.current.set(id, ws);
    ws.onopen = () => {
      backoffs.current.delete(id); // healthy again: reset backoff
      setTabs((prev) => prev.map((tab) =>
        tab.id === id ? { ...tab, connection: "connected" } : tab));
      // announce the real grid so the PTY matches what we render
      const emu = emus.current.get(id);
      if (emu) ws.send(JSON.stringify({ type: "resize", cols: emu.cols(), rows: emu.rows() }));
      const queued = pendingInput.current.get(id);
      if (queued) {
        ws.send(JSON.stringify({ type: "data", data: queued }));
        pendingInput.current.delete(id);
      }
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: string; frames?: unknown; exitCode?: number | null; code?: string };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "replay" && typeof msg.data === "string") {
        // server replays the bounded scrollback on every attach — rebuild the
        // emulator from scratch so reconnects never duplicate output
        const emu = getEmu(id);
        replaying.current.add(id);
        try {
          restoreTerminalReplay(emu, msg.data, msg.frames);
        } finally {
          replaying.current.delete(id);
        }
      }
      if (msg.type === "data" && typeof msg.data === "string") {
        getEmu(id).write(msg.data);
      }
      if (msg.type === "exit") {
        gone.current.add(id); // process ended — no point reconnecting
        setTabs((prev) => prev.map((t) => t.id === id
          ? { ...t, running: false, exitCode: msg.exitCode ?? null, connection: "disconnected" }
          : t));
      }
      if (msg.type === "error" && msg.code === "not-found") {
        gone.current.add(id); // PTY no longer exists (closed elsewhere / restart)
        dropTab(id);
      }
    };
    ws.onclose = () => {
      if (sockets.current.get(id) === ws) sockets.current.delete(id);
      if (!mounted.current || gone.current.has(id) || projectRef.current !== attachedProject) return;
      setTabs((prev) => prev.map((tab) =>
        tab.id === id && tab.running ? { ...tab, connection: "reconnecting" } : tab));
      // silent retry with backoff, reusing the SAME terminal id — the PTY
      // stays alive server-side and replays its scrollback on reattach
      const delay = backoffs.current.get(id) ?? nextTermBackoff(undefined);
      backoffs.current.set(id, nextTermBackoff(delay));
      const timer = setTimeout(() => { timers.current.delete(id); attach(id); }, delay);
      timers.current.set(id, timer);
    };
  };

  const spawn = async (cmd?: string) => {
    if (!projectId || workspaceInvalid) return;
    // The first shell has no TermPane yet. Measure its reserved viewport now,
    // so readline starts at the real width instead of wrapping a 120-column
    // startup prompt when the first resize arrives.
    const initialSize = measureTerminalGrid(initialBodyRef.current, initialProbeRef.current);
    if (initialSize) lastSize.current = { cols: initialSize.cols, rows: initialSize.rows };
    const { terminalId } = await api.createTerminal(projectId, {
      ...(sessionId ? { sessionId } : {}),
      ...(project?.repositories && selectedRepositoryId ? { repositoryId: selectedRepositoryId } : {}),
      ...(cmd ? { cmd } : {}),
      cols: lastSize.current.cols,
      rows: lastSize.current.rows,
    });
    const tab: Tab = {
      id: terminalId,
      title: cmd ?? selectedRepository?.alias ?? tr("terminalview.shellValue", { value: tabs.length + 1 }),
      running: true,
      connection: "connecting",
    };
    getEmu(terminalId);
    setTabs((prev) => [...prev, tab]);
    setActive(terminalId);
    attach(terminalId);
  };

  const closeTab = async (id: string) => {
    gone.current.add(id);
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
    sockets.current.get(id)?.close();
    sockets.current.delete(id);
    await api.closeTerminal(id).catch(() => {});
    dropTab(id);
  };

  const startRename = (t: Tab) => {
    setRenaming(t.id);
    setRenameVal(t.title);
  };

  const commitRename = (id: string) => {
    const title = renameVal.trim();
    setRenaming(null);
    if (!title) return;
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, title, customTitle: true } : t));
    void api.renameTerminal(id, title).catch(() => {});
  };

  // Adopt terminals that already exist for this project (e.g. after reload) —
  // the replay frame restores their visible scrollback on attach.
  useEffect(() => {
    let cancelled = false;
    setListLoaded(false);
    autoSpawnArmed.current = true; // fresh project: one auto-spawn allowed again
    // TerminalView survives project switches. Detach the previous project's
    // sockets without killing its PTYs; stale close handlers are generation-
    // guarded in attach(), so they cannot reconnect into the new project.
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    for (const ws of sockets.current.values()) ws.close();
    sockets.current.clear();
    backoffs.current.clear();
    gone.current.clear();
    pendingInput.current.clear();
    emus.current.clear();
    setTabs([]);
    setActive(null);
    if (!projectId) return () => { cancelled = true; };
    void api.listTerminals(projectId).then((list: TerminalInfo[]) => {
      if (cancelled) return;
      const scoped = list.filter((t) => {
        // A harness install/sign-in terminal belongs to the machine: every
        // view of the project shows it until it is closed.
        if (t.purpose === "harness-setup") return true;
        if (sessionId ? t.sessionId !== sessionId : t.sessionId) return false;
        if (selectedRepositoryId !== null && selectedRepositoryId !== undefined && !t.workspace && t.repositoryId !== selectedRepositoryId) return false;
        return true;
      });
      const adopted: Tab[] = scoped.map((t) => ({
          id: t.id,
          title: t.title || t.id.slice(0, 8),
          running: t.running,
          connection: "connecting",
          ...(t.sessionId ? { sessionId: t.sessionId } : {}),
          ...(t.repositoryId ? { repositoryId: t.repositoryId } : {}),
          ...(t.workspace ? { workspace: t.workspace } : {}),
          customTitle: Boolean(t.title && t.title !== generatedTerminalTitle(t) && t.title !== (t.cwd.split(/[\\/]/).pop() || "")),
          ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
        }));
      // A terminal announced while this list was loading (a custom action
      // that just opened its command here) keeps its tab and its focus.
      const adoptedIds = new Set(adopted.map((tab) => tab.id));
      setTabs((current) => [...adopted, ...current.filter((tab) => !adoptedIds.has(tab.id))]);
      setActive((current) => current ?? adopted[0]?.id ?? null);
      adopted.forEach((terminal) => {
        getEmu(terminal.id);
        attach(terminal.id);
      });
      setListLoaded(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generatedTerminalTitle, projectId, selectedRepositoryId, sessionId]);

  // One-click terminal: an ACTIVE terminal pane with a confirmed-empty terminal
  // list spawns + attaches one real shell — the tab only appears after the
  // server returned a terminalId, so there is no fake "connected" state.
  useEffect(() => {
    if (!visible) { autoSpawnArmed.current = true; return; }
    if (!projectId || !listLoaded || !autoSpawnArmed.current) return;
    autoSpawnArmed.current = false; // one shot per activation, even if tabs exist
    if (tabs.length === 0) void spawn().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectId, listLoaded, tabs.length]);

  useEffect(() => {
    mounted.current = true;
    const created = (event: Event) => {
      const detail = (event as CustomEvent<{
        terminalId?: unknown;
        projectId?: unknown;
        title?: unknown;
        sessionId?: unknown;
        repositoryId?: unknown;
        workspace?: TerminalInfo["workspace"];
        purpose?: unknown;
      }>).detail;
      if (
        typeof detail?.terminalId !== "string"
        || detail.projectId !== projectRef.current
        || gone.current.has(detail.terminalId)
      ) return;
      const machineWide = detail.purpose === "harness-setup";
      if (!machineWide && sessionId && detail.sessionId && detail.sessionId !== sessionId) return;
      if (!machineWide && selectedRepositoryId !== null && selectedRepositoryId !== undefined && detail.repositoryId && !detail.workspace && detail.repositoryId !== selectedRepositoryId) return;
      const terminalId = detail.terminalId;
      const title = typeof detail.title === "string" && detail.title.trim()
        ? detail.title.trim()
        : terminalId.slice(0, 8);
      setTabs((current) => current.some((tab) => tab.id === terminalId)
        ? current
        : [...current, {
          id: terminalId, title, running: true, connection: "connecting",
          ...(typeof detail.sessionId === "string" ? { sessionId: detail.sessionId } : {}),
          ...(typeof detail.repositoryId === "string" ? { repositoryId: detail.repositoryId } : {}),
          ...(detail.workspace ? { workspace: detail.workspace } : {}),
        }]);
      setActive(terminalId);
      getEmu(terminalId);
      attach(terminalId);
    };
    window.addEventListener("polyth:terminal-created", created);
    return () => {
      mounted.current = false;
      window.removeEventListener("polyth:terminal-created", created);
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      for (const ws of sockets.current.values()) ws.close();
      sockets.current.clear();
    };
  }, [selectedRepositoryId, sessionId]);

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  const activeId = tab?.id ?? null;

  const handlePaneResize = useCallback((cols: number, rows: number) => {
    lastSize.current = { cols, rows };
    if (!activeId) return;
    const ws = sockets.current.get(activeId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }, [activeId]);

  const handleSend = useCallback((data: string) => {
    if (activeId) sendTo(activeId, data);
  }, [activeId, sendTo]);

  const clearActive = () => {
    if (!activeId) return;
    emus.current.get(activeId)?.clearBuffer();
  };

  return (
    <div
      className="term-view"
      style={zoomedFontSize ? { "--terminal-font-size": `${zoomedFontSize}px` } as CSSProperties : undefined}
    >
      <div className="term-tabs">
        {repositoryOptions.length > 1 && <span className="term-repository-scope">
          <RepositoryScopePicker
            mode="one"
            label={tr("terminalview.repository")}
            repositories={repositoryOptions}
            value={selectedRepositoryId ?? null}
            onChange={chooseRepository}
          />
        </span>}
        <div className="term-tab-list ui-scroll-tabs" role="tablist" aria-label={tr("terminalview.terminalTabName")}>
          {tabs.map((t) => (
            <span key={t.id} className={`term-tab-group ${t.id === tab?.id ? "active" : ""}`}>
              {renaming === t.id ? (
                <TextInput
                  uiSize="sm"
                  className="term-tab-rename"
                  value={renameVal}
                  autoFocus
                  aria-label={tr("terminalview.terminalTabName")}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => commitRename(t.id)}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return;
                    if (e.key === "Enter") { e.preventDefault(); commitRename(t.id); }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button
                  role="tab"
                  aria-selected={t.id === tab?.id}
                  className={`term-tab ${t.id === tab?.id ? "active" : ""}`}
                  title={tr("terminalview.statusDoubleClickToRename", { status: connectionLabel(t.connection) })}
                  onClick={() => setActive(t.id)}
                  onDoubleClick={() => startRename(t)}
                >
                  <span
                    className={`term-connection ${t.connection}`}
                    aria-label={connectionLabel(t.connection)}
                    title={connectionLabel(t.connection)}
                  />
                  {t.title}
                  {!t.running && <span className="term-tab-dead"> {tr("terminalview.exited")}</span>}
                </button>
              )}
              <IconButton
                icon={CloseIcon}
                size="sm"
                variant="ghost"
                className="term-tab-x"
                title={tr("terminalview.closeValue", { title: t.title })}
                label={tr("terminalview.closeValue", { title: t.title })}
                onClick={() => void closeTab(t.id)}
              />
            </span>
          ))}
        </div>
        <span className="term-actions">
          {tab && (
            <>
              <IconButton
                icon={SearchIcon}
                size="sm"
                variant="ghost"
                title={tr("terminalview.findInTerminalShortcut")}
                label={tr("terminalview.findInTerminal")}
                onClick={() => setSearchSignal((n) => n + 1)}
              />
              <IconButton
                icon={DeleteIcon}
                size="sm"
                variant="ghost"
                title={tr("terminalview.clearTerminalShortcut")}
                label={tr("terminalview.clearTerminal")}
                onClick={clearActive}
              />
            </>
          )}
          <IconButton
            icon={AddIcon}
            size="sm"
            variant="ghost"
            className="term-new"
            label={tr("terminalview.newTerminal")}
            onClick={() => void spawn()}
            disabled={!projectId}
          />
        </span>
      </div>

      {!projectId && (
        <ProjectRequiredEmpty
          title={tr("terminalview.noProjectSelected")}
          description={tr("terminalview.openAProjectToUseTheTerminal")}
        />
      )}
      {projectId && !tab && (
        <div className="term-initial-container">
          <div ref={initialBodyRef} className="term-body term-initial-size" aria-hidden="true">
            <span ref={initialProbeRef} className="term-measure">{"W".repeat(100)}</span>
          </div>
          <EmptyState
            title={tr("terminalview.noTerminalYet")}
            description={tr("terminalview.openAShellInTheProjectFolder")}
            actionLabel={tr("terminalview.newTerminal")}
            onAction={() => void spawn()}
          />
        </div>
      )}
      {tab && (
        <TermPane
          key={tab.id}
          emu={getEmu(tab.id)}
          label={tab.title}
          running={tab.running}
          visible={visible}
          exitCode={tab.exitCode}
          send={handleSend}
          onResize={handlePaneResize}
          searchSignal={searchSignal}
          sessions={tabs.map((t) => ({ id: t.id, title: t.title, running: t.running }))}
          activeSessionId={tab.id}
          onSelectSession={setActive}
          onNewSession={() => void spawn().catch(() => {})}
          onCloseSession={() => void closeTab(tab.id)}
        />
      )}
    </div>
  );
}
