import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TerminalInfo } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { applyTerminalChunk, nextTermBackoff } from "../utils.ts";
import { usePaneVisible } from "../workspace/paneVisibility.ts";
import EmptyState from "./EmptyState.tsx";
import { Icon } from "../icons.tsx";

interface Tab {
  id: string;
  title: string;
  buf: string;
  running: boolean;
}

function wsUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/terminal/${id}`;
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
  // One-click terminal (finding 6): listLoaded flips true once the adopt fetch
  // below answered for the CURRENT project, so auto-spawn never fires on the
  // not-yet-known empty state. autoSpawnArmed re-arms on every hidden→visible
  // transition (and project switch) and is spent on first sight of a loaded
  // list — closing the last tab while the pane stays open must NOT respawn it.
  const [listLoaded, setListLoaded] = useState(false);
  const autoSpawnArmed = useRef(true);
  const sockets = useRef(new Map<string, WebSocket>());
  // F12 reconnect state: per-terminal backoff + pending timers; `gone` marks
  // terminals we closed deliberately (or the server reported missing) so the
  // reconnect loop stops instead of resurrecting them.
  const backoffs = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const gone = useRef(new Set<string>());
  const mounted = useRef(true);
  const preRef = useRef<HTMLPreElement>(null);

  const dropTab = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActive((a) => (a === id ? next[0]?.id ?? null : a));
      return next;
    });
  };

  const attach = (id: string) => {
    if (!mounted.current || sockets.current.has(id) || gone.current.has(id)) return;
    const ws = new WebSocket(wsUrl(id));
    sockets.current.set(id, ws);
    ws.onopen = () => backoffs.current.delete(id); // healthy again: reset backoff
    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: string; exitCode?: number | null; code?: string };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "replay" && typeof msg.data === "string") {
        // server replays the bounded scrollback on every attach — REPLACE the
        // local buffer so reconnects never duplicate output
        setTabs((prev) => prev.map((t) => t.id === id ? { ...t, buf: applyTerminalChunk("", msg.data!) } : t));
      }
      if (msg.type === "data" && typeof msg.data === "string") {
        setTabs((prev) => prev.map((t) => t.id === id ? { ...t, buf: applyTerminalChunk(t.buf, msg.data!) } : t));
      }
      if (msg.type === "exit") {
        gone.current.add(id); // process ended — no point reconnecting
        setTabs((prev) => prev.map((t) => t.id === id && t.running
          ? { ...t, running: false, buf: applyTerminalChunk(t.buf, `\n[exit ${msg.exitCode ?? 0}]\n`) }
          : t));
      }
      if (msg.type === "error" && msg.code === "not-found") {
        gone.current.add(id); // PTY no longer exists (closed elsewhere / restart)
        dropTab(id);
      }
    };
    ws.onclose = () => {
      if (sockets.current.get(id) === ws) sockets.current.delete(id);
      if (!mounted.current || gone.current.has(id)) return;
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
      cols: 120,
      rows: 32,
    });
    const tab: Tab = { id: terminalId, title: cmd ?? `shell · ${tabs.length + 1}`, buf: "", running: true };
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
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, title } : t));
    void api.renameTerminal(id, title).catch(() => {});
  };

  // Adopt terminals that already exist for this project (e.g. after reload) —
  // the replay frame restores their visible scrollback on attach.
  useEffect(() => {
    setListLoaded(false);
    autoSpawnArmed.current = true; // fresh project: one auto-spawn allowed again
    if (!projectId) { setTabs([]); setActive(null); return; }
    void api.listTerminals(projectId).then((list: TerminalInfo[]) => {
      setTabs((prev) => {
        const known = new Set(prev.map((t) => t.id));
        const extra = list.filter((t) => !known.has(t.id)).map((t) => ({
          id: t.id, title: t.title || t.id.slice(0, 8), buf: "", running: t.running,
        }));
        extra.forEach((t) => attach(t.id));
        const next = extra.length ? [...prev, ...extra] : prev;
        if (!active && next.length > 0) setActive(next[0]!.id);
        return next;
      });
      setListLoaded(true);
    });
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

  useEffect(() => () => {
    mounted.current = false;
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    for (const ws of sockets.current.values()) ws.close();
    sockets.current.clear();
  }, []);

  useEffect(() => {
    preRef.current?.scrollTo(0, preRef.current.scrollHeight);
  }, [tabs, active]);

  // Focus the terminal whenever the active tab changes (incl. first open).
  useEffect(() => {
    if (active) preRef.current?.focus();
  }, [active]);

  const send = (id: string, data: string) => {
    const ws = sockets.current.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    } else {
      void api.terminalInput(id, data).catch(() => {});
    }
  };

  const onKey = (e: KeyboardEvent<HTMLPreElement>) => {
    if (!active) return;
    e.preventDefault();
    if (e.key === "Enter") { send(active, "\r"); return; }
    if (e.key === "Backspace") { send(active, "\x7f"); return; }
    if (e.key === "Tab") { send(active, "\t"); return; }
    if (e.key === "ArrowUp") { send(active, "\x1b[A"); return; }
    if (e.key === "ArrowDown") { send(active, "\x1b[B"); return; }
    if (e.key === "ArrowRight") { send(active, "\x1b[C"); return; }
    if (e.key === "ArrowLeft") { send(active, "\x1b[D"); return; }
    if (e.key === "c" && e.ctrlKey) { send(active, "\x03"); return; }
    if (e.key === "d" && e.ctrlKey) { send(active, "\x04"); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) send(active, e.key);
  };

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="term-view">
      <div className="term-tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`term-tab-group ${t.id === tab?.id ? "active" : ""}`}>
            {renaming === t.id ? (
              <input
                className="term-tab-rename"
                value={renameVal}
                autoFocus
                aria-label="Terminal tab name"
                onChange={(e) => setRenameVal(e.target.value)}
                onBlur={() => commitRename(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(t.id); }
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                className={`term-tab ${t.id === tab?.id ? "active" : ""}`}
                title="Double-click to rename"
                onClick={() => setActive(t.id)}
                onDoubleClick={() => startRename(t)}
              >
                {t.title}
                {!t.running && <span className="term-tab-dead"> ·exited</span>}
              </button>
            )}
            <button
              className="term-tab-x"
              title={`Close ${t.title}`}
              aria-label={`Close ${t.title}`}
              onClick={() => void closeTab(t.id)}
            ><Icon.close /></button>
          </span>
        ))}
        <span className="header-spacer" />
        <button className="term-new" title="New terminal" aria-label="New terminal" onClick={() => void spawn()} disabled={!projectId}><Icon.plus /></button>
      </div>

      {!projectId && <EmptyState title="No project selected" description="Open a project to use the terminal." />}
      {projectId && !tab && (
        <EmptyState
          title="No terminal yet"
          description="Open a shell in the project folder."
          actionLabel="New terminal"
          onAction={() => void spawn()}
        />
      )}
      {tab && (
        <pre
          ref={preRef}
          className="term-body"
          tabIndex={0}
          aria-label={`Terminal ${tab.title}`}
          onKeyDown={onKey}
          onClick={() => preRef.current?.focus()}
        >{tab.buf || " "}<span className="term-caret" /></pre>
      )}
    </div>
  );
}
