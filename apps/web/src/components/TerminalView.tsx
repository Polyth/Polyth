import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TerminalInfo } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { applyTerminalChunk } from "../utils.ts";

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
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const sockets = useRef(new Map<string, WebSocket>());
  const preRef = useRef<HTMLPreElement>(null);

  const attach = (id: string) => {
    if (sockets.current.has(id)) return;
    const ws = new WebSocket(wsUrl(id));
    sockets.current.set(id, ws);
    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: string; exitCode?: number };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "data" && typeof msg.data === "string") {
        setTabs((prev) => prev.map((t) => t.id === id ? { ...t, buf: applyTerminalChunk(t.buf, msg.data!) } : t));
      }
      if (msg.type === "exit") {
        setTabs((prev) => prev.map((t) => t.id === id ? { ...t, running: false, buf: applyTerminalChunk(t.buf, `\n[exit ${msg.exitCode ?? 0}]\n`) } : t));
      }
    };
    ws.onclose = () => { sockets.current.delete(id); };
  };

  const spawn = async (cmd?: string) => {
    if (!projectId) return;
    const { terminalId } = await api.createTerminal(projectId, {
      ...(sessionId ? { sessionId } : {}),
      ...(cmd ? { cmd } : {}),
      cols: 120,
      rows: 32,
    });
    const tab: Tab = { id: terminalId, title: cmd ?? `zsh · ${tabs.length + 1}`, buf: "", running: true };
    setTabs((prev) => [...prev, tab]);
    setActive(terminalId);
    attach(terminalId);
  };

  const closeTab = async (id: string) => {
    sockets.current.get(id)?.close();
    sockets.current.delete(id);
    await api.closeTerminal(id).catch(() => {});
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (active === id) setActive(next[0]?.id ?? null);
      return next;
    });
  };

  // Adopt terminals that already exist for this project (e.g. after reload).
  useEffect(() => {
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => () => {
    for (const ws of sockets.current.values()) ws.close();
    sockets.current.clear();
  }, []);

  useEffect(() => {
    preRef.current?.scrollTo(0, preRef.current.scrollHeight);
  }, [tabs, active]);

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

  const submitLine = () => {
    if (!active || !line) return;
    send(active, line + "\r");
    setLine("");
  };

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="term-view">
      <div className="term-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`term-tab ${t.id === tab?.id ? "active" : ""}`}
            onClick={() => setActive(t.id)}
          >
            <span>{t.title}</span>
            <span
              className="term-tab-x"
              onClick={(e) => { e.stopPropagation(); void closeTab(t.id); }}
            >×</span>
          </button>
        ))}
        <span className="header-spacer" />
        <button className="term-new" onClick={() => void spawn()} disabled={!projectId}>+ New</button>
      </div>

      {!projectId && <div className="view-empty">Select a project to open a terminal.</div>}
      {projectId && !tab && (
        <div className="view-empty">
          <button className="primary-btn" onClick={() => void spawn()}>New terminal</button>
        </div>
      )}
      {tab && (
        <>
          <pre
            ref={preRef}
            className="term-body"
            tabIndex={0}
            onKeyDown={onKey}
            onClick={() => preRef.current?.focus()}
          >{tab.buf || " "}<span className="term-caret" /></pre>
          <div className="term-input-row">
            <span className="term-prompt">❯</span>
            <input
              className="term-input"
              value={line}
              placeholder="Type a command…"
              onChange={(e) => setLine(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitLine(); } }}
            />
            <span className="term-caret" />
          </div>
        </>
      )}
    </div>
  );
}
