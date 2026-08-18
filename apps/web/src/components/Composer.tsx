import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { useActiveModel, useStore } from "../store.ts";
import { sendMessage, abortSession } from "../init.ts";
import { api, type SlashCommand, type SnippetDef } from "../api.ts";
import { filterCommands, filterSnippets, type AutocompleteItem } from "../utils.ts";

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

export default function Composer() {
  const [text, setText] = useState("");
  const [modelValue, setModelValue] = useState("");
  const [agentValue, setAgentValue] = useState("");
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const model = useActiveModel();
  const working = model.turn?.status === "working";

  // Autocomplete state
  const [acItems, setAcItems] = useState<AutocompleteItem[]>(EMPTY_AC);
  const [acIndex, setAcIndex] = useState(0);
  const [acOpen, setAcOpen] = useState(false);
  const [acType, setAcType] = useState<"cmd" | "snip">("cmd");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load commands and snippets from API (once per project change)
  const activeProjectId = useStore((s) => s.activeProjectId);
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

  // Listen for polyth:composer-insert events (from FilesPanel Attach to chat)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "string") {
        setText((prev) => (prev ? prev + " " + detail : detail));
      }
    };
    window.addEventListener("polyth:composer-insert", handler);
    return () => window.removeEventListener("polyth:composer-insert", handler);
  }, []);

  const groups = new Map<string, typeof models>();
  for (const m of models) {
    const g = groups.get(m.providerID) ?? [];
    g.push(m);
    groups.set(m.providerID, g);
  }

  const send = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    void sendMessage(t, modelRefFromValue(modelValue), agentValue || undefined);
    setText("");
    setAcOpen(false);
  }, [text, modelValue, agentValue]);

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

    // Original send behavior
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Update autocomplete when text changes
  const onTextChange = useCallback(
    (val: string) => {
      setText(val);
      // Check if we're at the start of text typing / or #
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
    [commands, snippets],
  );

  return (
    <div className="composer">
      <div style={{ position: "relative" }}>
        <textarea
          ref={textareaRef}
          rows={3}
          value={text}
          placeholder="Ask Polyth to explore, build, or review…"
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
                  // apply
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
      <div className="composer-row">
        <select value={modelValue} onChange={(e) => setModelValue(e.target.value)} title="Model">
          <option value="">Model: Default</option>
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
        <select value={agentValue} onChange={(e) => setAgentValue(e.target.value)} title="Agent">
          <option value="">Agent: Default</option>
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
              {a.description ? ` — ${a.description}` : ""}
            </option>
          ))}
        </select>
        {working ? (
          <button className="stop" onClick={() => void abortSession()}>
            Stop
          </button>
        ) : (
          <button className="send" onClick={send} disabled={!text.trim()}>
            Send <span className="send-key">↵</span>
          </button>
        )}
      </div>
    </div>
  );
}
