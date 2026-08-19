import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ReactNode } from "react";
import { useActiveModel, useStore, setUiError } from "../store.ts";
import { sendMessage, abortSession, createSession } from "../init.ts";
import { api, type SlashCommand, type SnippetDef } from "../api.ts";
import { filterCommands, filterSnippets, type AutocompleteItem } from "../utils.ts";
import { friendlyError, modKeyLabel, parseModelRef } from "../settings.ts";
import { providerColor } from "../format.ts";

function modelRefFromValue(value: string): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { providerID?: unknown; modelID?: unknown };
    if (typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return { providerID: parsed.providerID, modelID: parsed.modelID };
    }
  } catch {
    // fall through
  }
  return undefined;
}

const EMPTY_AC: AutocompleteItem[] = [];
const EMPTY_SLCMD: SlashCommand[] = [];
const EMPTY_SNIP: SnippetDef[] = [];

const CHIP_STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const STARTERS: Array<{ label: string; icon: ReactNode }> = [
  {
    label: "Explore the codebase",
    icon: <svg width="13" height="13" viewBox="0 0 16 16" {...CHIP_STROKE}><path d="M8 2.2 9.3 6l3.8 1.3-3.8 1.3L8 12.4 6.7 8.6 2.9 7.3 6.7 6z" /></svg>,
  },
  {
    label: "Review my recent changes",
    icon: <svg width="13" height="13" viewBox="0 0 16 16" {...CHIP_STROKE}><circle cx="4.6" cy="4" r="1.7" /><circle cx="4.6" cy="12" r="1.7" /><circle cx="11.4" cy="5.6" r="1.7" /><path d="M4.6 5.7v4.6M11.4 7.3c0 2.3-2.5 2.5-5 3" /></svg>,
  },
  {
    label: "Add tests",
    icon: <svg width="13" height="13" viewBox="0 0 16 16" {...CHIP_STROKE}><path d="M3.4 8.4 6.4 11.4l6.2-6.8" /></svg>,
  },
  {
    label: "Debug an issue",
    icon: <svg width="13" height="13" viewBox="0 0 16 16" {...CHIP_STROKE}><rect x="1.9" y="2.9" width="12.2" height="10.2" rx="2.2" /><path d="M4.7 6.3 6.9 8l-2.2 1.7M8.5 10.1h2.9" /></svg>,
  },
  {
    label: "Explain this project",
    icon: <svg width="13" height="13" viewBox="0 0 16 16" {...CHIP_STROKE}><path d="M2.4 3.2c1.9-.6 3.7-.5 5.6.5v9c-1.9-1-3.7-1.1-5.6-.5zM13.6 3.2c-1.9-.6-3.7-.5-5.6.5v9c1.9-1 3.7-1.1 5.6-.5z" /></svg>,
  },
];

export default function Composer({ variant = "docked" }: { variant?: "docked" | "hero" }) {
  const [text, setText] = useState("");
  const [modelValue, setModelValue] = useState("");
  const [agentValue, setAgentValue] = useState("");
  const [busy, setBusy] = useState(false);
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const settings = useStore((s) => s.settings);
  const sessionId = useStore((s) => s.activeSessionId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const working = model.turn?.status === "working";
  const noModels = models.length === 0;
  const mod = modKeyLabel();

  // Autocomplete state
  const [acItems, setAcItems] = useState<AutocompleteItem[]>(EMPTY_AC);
  const [acIndex, setAcIndex] = useState(0);
  const [acOpen, setAcOpen] = useState(false);
  const [acType, setAcType] = useState<"cmd" | "snip">("cmd");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load commands and snippets from API (once per project change)
  const [commands, setCommands] = useState<SlashCommand[]>(EMPTY_SLCMD);
  const [snippets, setSnippets] = useState<SnippetDef[]>(EMPTY_SNIP);

  useEffect(() => {
    if (!activeProjectId) { setCommands(EMPTY_SLCMD); setSnippets(EMPTY_SNIP); return; }
    void api.listCommands(activeProjectId).then((r) => {
      setCommands(r.commands);
      setSnippets(r.snippets);
    }).catch(() => {
      setCommands(EMPTY_SLCMD);
      setSnippets(EMPTY_SNIP);
    });
  }, [activeProjectId]);

  const autogrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, []);

  // polyth:composer-insert appends text (FilesPanel @-attach, starter chips);
  // polyth:composer-focus focuses the textarea (command palette).
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "string") {
        setText((prev) => (prev ? prev + " " + detail : detail));
        requestAnimationFrame(() => { autogrow(); textareaRef.current?.focus(); });
      }
    };
    const onFocus = () => textareaRef.current?.focus();
    window.addEventListener("polyth:composer-insert", onInsert);
    window.addEventListener("polyth:composer-focus", onFocus);
    return () => {
      window.removeEventListener("polyth:composer-insert", onInsert);
      window.removeEventListener("polyth:composer-focus", onFocus);
    };
  }, [autogrow]);

  const groups = new Map<string, typeof models>();
  for (const m of models) {
    const g = groups.get(m.providerID) ?? [];
    g.push(m);
    groups.set(m.providerID, g);
  }

  // Default-model preference (Settings → Models) applies when the session has
  // no model yet and the user hasn't picked one from the pill.
  const prefRef = settings.defaultModel ? parseModelRef(settings.defaultModel) : undefined;
  const prefDesc = prefRef
    ? models.find((m) => m.providerID === prefRef.providerID && m.modelID === prefRef.modelID)
    : undefined;

  const send = useCallback(() => {
    const t = text.trim();
    if (!t || noModels || busy) return;
    const explicit = modelRefFromValue(modelValue);
    const fallback = !session?.model && prefDesc
      ? { providerID: prefDesc.providerID, modelID: prefDesc.modelID }
      : undefined;
    setBusy(true);
    void (async () => {
      try {
        if (!sessionId) {
          if (!activeProjectId) return;
          await createSession(activeProjectId);
        }
        await sendMessage(t, explicit ?? fallback, agentValue || undefined);
        setText("");
        setAcOpen(false);
        requestAnimationFrame(autogrow);
      } catch (err) {
        setUiError(friendlyError("Couldn’t create a session", err));
      } finally {
        setBusy(false);
      }
    })();
  }, [text, modelValue, agentValue, noModels, busy, sessionId, activeProjectId, session, prefDesc, autogrow]);

  const completeAutocomplete = useCallback(() => {
    if (!acOpen || acItems.length === 0) return false;
    const item = acItems[acIndex];
    if (!item) return false;
    setText(item.value);
    setAcOpen(false);
    textareaRef.current?.focus();
    return true;
  }, [acOpen, acItems, acIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Autocomplete navigation
    if (acOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (completeAutocomplete()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "Escape") {
        setAcOpen(false);
        return;
      }
    }

    if (e.key === "Enter") {
      // Mod+Enter always sends; plain Enter sends only with "Send on Enter".
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        send();
        return;
      }
      if (settings.sendOnEnter && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    }
  };

  // Update autocomplete when text changes
  const onTextChange = useCallback(
    (val: string) => {
      setText(val);
      autogrow();
      const firstToken = val.match(/^([\/#])(\S*)$/);
      if (firstToken) {
        const trigger = firstToken[1]!;
        const prefix = firstToken[2]!;
        if (trigger === "/") {
          const items = filterCommands(commands, prefix);
          setAcItems(items);
          setAcType("cmd");
          setAcIndex(0);
          setAcOpen(items.length > 0);
          return;
        }
        if (trigger === "#") {
          const items = filterSnippets(snippets, prefix);
          setAcItems(items);
          setAcType("snip");
          setAcIndex(0);
          setAcOpen(items.length > 0);
          return;
        }
      }
      setAcOpen(false);
    },
    [commands, snippets, autogrow],
  );

  const sessionModelDesc = session?.model
    ? models.find((m) => m.providerID === session.model!.providerID && m.modelID === session.model!.modelID)
    : undefined;
  const defaultModelLabel = session?.model
    ? (sessionModelDesc?.name ?? session.model.modelID)
    : prefDesc
      ? (prefDesc.name || prefDesc.modelID)
      : (models.length > 0 ? "Default model" : "No models");
  const defaultAgentLabel = session?.agent ?? agents[0]?.name ?? "Agent";

  const explicitRef = modelRefFromValue(modelValue);
  const swatchProvider = explicitRef?.providerID
    ?? session?.model?.providerID
    ?? prefDesc?.providerID
    ?? models[0]?.providerID
    ?? "";

  const empty = model.messages.length === 0;
  const sendLabel = working ? null : (
    <button className="send" onClick={send} disabled={!text.trim() || noModels || busy}>
      Send <span className="send-key">{settings.sendOnEnter ? "↵" : `${mod}↵`}</span>
    </button>
  );

  const chips = (
    <div className="starter-chips" aria-label="Suggestions">
      {STARTERS.map(({ label, icon }) => (
        <button
          key={label}
          className="chip"
          onClick={() => {
            setText(label);
            requestAnimationFrame(() => { autogrow(); textareaRef.current?.focus(); });
          }}
        >{icon}{label}</button>
      ))}
    </div>
  );

  const card = (
    <div className="composer-card">
      <div className="composer-input">
        <textarea
          ref={textareaRef}
          rows={3}
          value={text}
          placeholder="Ask Polyth to explore, build, or review…   @ files   / commands   # snippets"
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {acOpen && acItems.length > 0 && (
          <div className="ac-popup">
            {acType === "cmd" && <div className="ac-header">Commands</div>}
            {acType === "snip" && <div className="ac-header">Snippets</div>}
            {acItems.map((item, i) => (
              <div
                key={i}
                className={`ac-item ${i === acIndex ? "ac-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setAcIndex(i);
                  setText(item.value);
                  setAcOpen(false);
                  textareaRef.current?.focus();
                }}
                onMouseEnter={() => setAcIndex(i)}
              >
                <span className="ac-label">{item.label}</span>
                <span className="ac-detail">{item.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="composer-bar">
        <span className="pill pill-select" title="Model">
          <span className="swatch" style={{ background: providerColor(swatchProvider) }} />
          <select value={modelValue} onChange={(e) => setModelValue(e.target.value)} aria-label="Model">
            <option value="">{defaultModelLabel}</option>
            {[...groups.entries()].map(([provider, ms]) => (
              <optgroup key={provider} label={provider}>
                {ms.map((m) => (
                  <option key={m.modelID} value={JSON.stringify({ providerID: m.providerID, modelID: m.modelID })}>
                    {m.name ?? m.modelID}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <svg className="pill-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3.8 6.2 8 10.4l4.2-4.2" /></svg>
        </span>
        <span className="pill pill-select" title="Agent">
          <span className="swatch agent" />
          <select value={agentValue} onChange={(e) => setAgentValue(e.target.value)} aria-label="Agent">
            <option value="">{defaultAgentLabel}</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.description ? ` — ${a.description}` : ""}
              </option>
            ))}
          </select>
          <svg className="pill-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3.8 6.2 8 10.4l4.2-4.2" /></svg>
        </span>
        {noModels && (
          <span className="composer-notice">No models yet — OpenCode will fill this when a provider is configured.</span>
        )}
        <span className="header-spacer" />
        {working ? (
          <button className="stop" onClick={() => void abortSession()}>Stop</button>
        ) : sendLabel}
      </div>
    </div>
  );

  if (variant === "hero") {
    return (
      <div className="composer-hero">
        {card}
        {chips}
      </div>
    );
  }

  return (
    <div className="composer">
      {empty && !working && chips}
      {card}
    </div>
  );
}
