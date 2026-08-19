import { Fragment, useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { useActiveModel, useStore, setActiveView } from "../store.ts";
import { sendMessage, abortSession } from "../init.ts";
import { api, type SlashCommand, type SnippetDef } from "../api.ts";
import { filterCommands, filterSnippets, type AutocompleteItem } from "../utils.ts";
import { PERSONAS, usePrefs } from "../prefs.ts";
import { renderSlot } from "../slots.ts";
import { dragKind, dropIntoSession } from "../dnd.ts";
import { useDraft } from "../drafts.ts";
import { COMPOSER_INSERT, drainInserts } from "../composerInsert.ts";
import type { PickerItem } from "../picker.ts";
import Picker from "./Picker.tsx";
import { isFavorite, modelKey, sortModels } from "@polyth/models";
import { noteModelUsed, useModelPrefs } from "../modelPrefs.ts";

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
  const [modelValue, setModelValue] = useState("");
  const [agentValue, setAgentValue] = useState("");
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const { draft: text, setDraft: setText, clearDraft } = useDraft(session?.id ?? null);
  const model = useActiveModel();
  const working = model.turn?.status === "working";
  const prefs = usePrefs();
  // Creator persona: plain-language composer, no model/agent jargon.
  const simple = (prefs.persona ? PERSONAS[prefs.persona].composer : "full") === "simple";
  const noModels = models.length === 0;

  // Drag-and-drop: tree paths attach as @path, desktop files upload first.
  const [dropHint, setDropHint] = useState<"path" | "files" | null>(null);

  // Autocomplete state
  const [acItems, setAcItems] = useState<AutocompleteItem[]>(EMPTY_AC);
  const [acIndex, setAcIndex] = useState(0);
  const [acOpen, setAcOpen] = useState(false);
  const [acType, setAcType] = useState<"cmd" | "snip">("cmd");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Explicit selections reset when the session changes (UX-30).
  useEffect(() => {
    setModelValue("");
    setAgentValue("");
  }, [session?.id]);

  // Auto-grow up to 40vh; manual vertical resize stays possible (UX-11).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.4)}px`;
  }, [text]);

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

  // Composer inserts (Files @, drag-drop, starter chips). preventDefault marks
  // the event consumed; anything queued while unmounted drains now.
  useEffect(() => {
    const insert = (detail: string) =>
      setText((prev) => (prev ? `${prev} ${detail}` : detail));
    for (const queued of drainInserts()) insert(queued);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      e.preventDefault();
      insert(detail);
      textareaRef.current?.focus();
    };
    window.addEventListener(COMPOSER_INSERT, handler);
    return () => window.removeEventListener(COMPOSER_INSERT, handler);
  }, []);

  const send = useCallback(() => {
    const t = text.trim();
    if (!t || noModels) return;
    void sendMessage(t, modelRefFromValue(modelValue), agentValue || undefined);
    clearDraft();
    setAcOpen(false);
  }, [text, modelValue, agentValue, clearDraft, noModels]);

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

  const leading = renderSlot("composer.leading", { sessionId: session?.id });
  const trailing = renderSlot("composer.trailing", { sessionId: session?.id });

  // Favorites float first (Settings > Providers & Models); picking records recency.
  const modelPrefs = useModelPrefs();
  const modelItems: PickerItem[] = [
    { id: "", label: session?.model ? session.model.modelID : "Default", group: "" },
    ...sortModels(models, modelPrefs).map((m) => {
      const fav = isFavorite(modelPrefs, modelKey(m));
      return {
        id: JSON.stringify({ providerID: m.providerID, modelID: m.modelID }),
        label: fav ? `★ ${m.name || m.modelID}` : m.name || m.modelID,
        group: fav ? "Favorites" : m.providerID,
        keywords: [m.providerID, m.modelID],
      };
    }),
  ];
  const pickModel = (value: string) => {
    setModelValue(value);
    const ref = modelRefFromValue(value);
    if (ref) noteModelUsed(`${ref.providerID}/${ref.modelID}`);
  };
  const agentItems: PickerItem[] = [
    { id: "", label: session?.agent ? `${session.agent}` : "Default", group: "" },
    ...agents.map((a) => ({
      id: a.name,
      label: a.name,
      group: "",
      ...(a.description ? { detail: a.description } : {}),
    })),
  ];

  return (
    <div
      className="composer"
      onDragOver={(e) => { const k = dragKind(e.dataTransfer); if (k) { e.preventDefault(); setDropHint(k); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(null); }}
      onDrop={(e) => {
        const k = dragKind(e.dataTransfer);
        setDropHint(null);
        if (!k || !activeProjectId) return;
        e.preventDefault();
        void dropIntoSession(e.dataTransfer, activeProjectId);
      }}
    >
      {dropHint && (
        <div className="drop-hint">{dropHint === "path" ? "Attach to session" : "Drop to upload"}</div>
      )}
      {simple && (prefs.plugins.includes("multirun") || prefs.plugins.includes("fusion")) && (
        <div className="chip-row">
          {prefs.plugins.includes("multirun") && (
            <button className="chip" onClick={() => setActiveView("multirun")}>Try 3 directions</button>
          )}
          {prefs.plugins.includes("fusion") && (
            <button className="chip" onClick={() => setActiveView("fusion")}>Combine the best parts</button>
          )}
        </div>
      )}
      {noModels && (
        <div className="composer-note" role="status">
          No models available — check that the backend is running and configured.
        </div>
      )}
      <div style={{ position: "relative" }}>
        <textarea
          ref={textareaRef}
          rows={3}
          value={text}
          placeholder={simple
            ? "Describe what you want — it gets built as you watch…"
            : "Ask Polyth to explore, build, or review — / for commands, # for snippets"}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {acOpen && acItems.length > 0 && (
          <div className="ac-popup">
            <div className="ac-header">{acType === "cmd" ? "Commands" : "Snippets"}</div>
            <div className="ac-list" role="listbox" aria-label={acType === "cmd" ? "Commands" : "Snippets"}>
              {acItems.map((item, i) => (
                <div
                  key={i}
                  role="option"
                  aria-selected={i === acIndex}
                  ref={i === acIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : null}
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
            <div className="ac-footer">
              <span><kbd>↑↓</kbd> navigate</span>
              <span><kbd>↵</kbd> / <kbd>Tab</kbd> insert</span>
              <span><kbd>Esc</kbd> dismiss</span>
            </div>
          </div>
        )}
      </div>
      <div className="composer-row">
        {leading.map((n, i) => <Fragment key={i}>{n}</Fragment>)}
        {!simple && !noModels && (
          <Picker label="Model" direction="up" items={modelItems} value={modelValue} onPick={pickModel} />
        )}
        {!simple && agents.length > 0 && (
          <Picker label="Agent" direction="up" items={agentItems} value={agentValue} onPick={setAgentValue} />
        )}
        <span className="header-spacer" />
        {trailing.map((n, i) => <Fragment key={i}>{n}</Fragment>)}
        {working ? (
          <button className="stop" onClick={() => void abortSession()}>
            Stop
          </button>
        ) : (
          <button className="send" onClick={send} disabled={!text.trim() || noModels}>
            Send <span className="send-key">↵</span>
          </button>
        )}
      </div>
    </div>
  );
}
