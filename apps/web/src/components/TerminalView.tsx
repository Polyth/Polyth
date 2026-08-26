// Terminal pane: tabs of real shells over /ws/terminal/:id. Each tab owns a
// TerminalEmulator instance (VT parser + cell grid, src/terminal/emulator.ts)
// that lives OUTSIDE React state — WS frames feed it directly and TermPane
// subscribes for coalesced repaints. Replay frames rebuild the emulator from
// scratch so reconnects never duplicate output (F12).
import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalInfo } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { nextTermBackoff } from "../utils.ts";
import { usePaneVisible } from "../workspace/paneVisibility.ts";
import { createTerminalEmulator, type TerminalEmulator } from "../terminal/emulator.ts";
import EmptyState from "./EmptyState.tsx";
import TermPane from "./TermPane.tsx";
import { Icon } from "../icons.tsx";
import { tr } from "../i18n/index.ts";

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

export default function TerminalView() {
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === s.activeSessionId) ?? null);
  const visible = usePaneVisible();
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
  // F12 reconnect state: per-terminal backoff + pending timers; `gone` marks
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
      emu.onResponse((data) => sendTo(id, data));
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
    if (!mounted.current || !projectId || sockets.current.has(id) || gone.current.has(id)) return;
    const attachedProject = projectId;
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
      let msg: { type?: string; data?: string; exitCode?: number | null; code?: string };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "replay" && typeof msg.data === "string") {
        // server replays the bounded scrollback on every attach — rebuild the
        // emulator from scratch so reconnects never duplicate output
        const emu = getEmu(id);
        emu.reset();
        emu.write(msg.data);
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
    if (!projectId) return;
    const { terminalId } = await api.createTerminal(projectId, {
      ...(sessionId ? { sessionId } : {}),
      ...(session?.worktreePath ? { cwd: session.worktreePath } : {}),
      ...(cmd ? { cmd } : {}),
      cols: lastSize.current.cols,
      rows: lastSize.current.rows,
    });
    const tab: Tab = {
      id: terminalId,
      title: cmd ?? tr("terminalview.shellValue", { value: tabs.length + 1 }),
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
      const adopted: Tab[] = list.map((t) => ({
          id: t.id,
          title: t.title || t.id.slice(0, 8),
          running: t.running,
          connection: "connecting",
          ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
        }));
      setTabs(adopted);
      setActive(adopted[0]?.id ?? null);
      adopted.forEach((terminal) => {
        getEmu(terminal.id);
        attach(terminal.id);
      });
      setListLoaded(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
    return () => {
      mounted.current = false;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      for (const ws of sockets.current.values()) ws.close();
      sockets.current.clear();
    };
  }, []);

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
    <div className="term-view">
      <div className="term-tabs">
        <div className="term-tab-list" role="tablist" aria-label={tr("terminalview.terminalTabName")}>
          {tabs.map((t) => (
            <span key={t.id} className={`term-tab-group ${t.id === tab?.id ? "active" : ""}`}>
              {renaming === t.id ? (
                <input
                  className="term-tab-rename"
                  value={renameVal}
                  autoFocus
                  aria-label={tr("terminalview.terminalTabName")}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => commitRename(t.id)}
                  onKeyDown={(e) => {
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
              {renaming !== t.id && (
                <button
                  className="term-tab-rename-action"
                  title={`${tr("common.rename")}: ${t.title}`}
                  aria-label={`${tr("common.rename")}: ${t.title}`}
                  onClick={() => startRename(t)}
                ><Icon.pencil /></button>
              )}
              <button
                className="term-tab-x"
                title={tr("terminalview.closeValue", { title: t.title })}
                aria-label={tr("terminalview.closeValue", { title: t.title })}
                onClick={() => void closeTab(t.id)}
              ><Icon.close /></button>
            </span>
          ))}
        </div>
        <span className="term-actions">
          {tab && (
            <>
              <button
                title={tr("terminalview.findInTerminalShortcut")}
                aria-label={tr("terminalview.findInTerminal")}
                onClick={() => setSearchSignal((n) => n + 1)}
              ><Icon.search /></button>
              <button
                title={tr("terminalview.clearTerminalShortcut")}
                aria-label={tr("terminalview.clearTerminal")}
                onClick={clearActive}
              ><Icon.trash /></button>
            </>
          )}
          <button className="term-new" title={tr("terminalview.newTerminal")} aria-label={tr("terminalview.newTerminal")} onClick={() => void spawn()} disabled={!projectId}><Icon.plus /></button>
        </span>
      </div>

      {!projectId && <EmptyState title={tr("terminalview.noProjectSelected")} description={tr("terminalview.openAProjectToUseTheTerminal")} />}
      {projectId && !tab && (
        <EmptyState
          title={tr("terminalview.noTerminalYet")}
          description={tr("terminalview.openAShellInTheProjectFolder")}
          actionLabel={tr("terminalview.newTerminal")}
          onAction={() => void spawn()}
        />
      )}
      {tab && (
        <TermPane
          key={tab.id}
          emu={getEmu(tab.id)}
          label={tab.title}
          running={tab.running}
          exitCode={tab.exitCode}
          send={handleSend}
          onResize={handlePaneResize}
          searchSignal={searchSignal}
        />
      )}
    </div>
  );
}
