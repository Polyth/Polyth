import { Fragment, useState, useRef, useEffect, useCallback, type ClipboardEvent, type KeyboardEvent } from "react";
import { getState, useActiveModel, useStore, setActiveView, setUiError } from "../store.ts";
import { sendMessage, abortSession, createSession } from "../init.ts";
import { api, type SlashCommand, type SnippetDef } from "../api.ts";
import { filterCommands, filterSnippets, loadDraft, saveDraft, type AutocompleteItem } from "../utils.ts";
import { PERSONAS, usePrefs } from "../prefs.ts";
import { renderSlot } from "../slots.ts";
import { dragKind, dropIntoSession } from "../dnd.ts";
import {
  attachUpload, parseGithubUrl, removeAttachment, takeAttachments,
  tryAttachGithubUrl, usePendingAttachments,
} from "../attachments.ts";
import AttachmentPills from "./AttachmentPills.tsx";
import { COMPOSER_INSERT, COMPOSER_REPLACE, drainInserts } from "../composerInsert.ts";
import { activeToken, completeToken, shellCommand, type PromptToken } from "../composer/language.ts";
import {
  emptyPromptHistoryCursor,
  promptHistory,
  restorePromptHistoryDraft,
  stepPromptHistory,
} from "../composer/history.ts";
import type { PickerItem } from "../picker.ts";
import Picker from "./Picker.tsx";
import AdaptiveTextInput, { type TextInputHandle } from "./input/AdaptiveTextInput.tsx";
import ComposerFocusDialog from "./ComposerFocusDialog.tsx";
import QueuedMessageList from "./QueuedMessageList.tsx";
import { isFavorite, modelKey, sortModels } from "@polyth/models";
import { noteModelUsed, useModelPrefs } from "../modelPrefs.ts";
import { getUiSettings } from "../uiPrefs.ts";
import { migrateFavoritesOnce, useProfiles } from "../profiles.ts";
import AgentProfileForm from "./AgentProfileForm.tsx";
import PendingChangesBar from "./PendingChangesBar.tsx";
import type { AgentProfile } from "@polyth/contracts";
import { agentPickerDefaultLabel, modelPickerDefaultLabel } from "../composerDefaults.ts";
import { modKeyLabel, parseModelRef } from "../settings.ts";

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
const STARTERS = [
  "Explore the codebase",
  "Review my recent changes",
  "Add tests",
  "Debug an issue",
  "Explain this project",
];

export default function Composer({ variant = "docked" }: { variant?: "docked" | "hero" }) {
  const [modelValue, setModelValue] = useState("");
  const [agentValue, setAgentValue] = useState("");
  const [profileValue, setProfileValue] = useState("");
  const [pinSeed, setPinSeed] = useState<{ providerID: string; modelID: string; name?: string } | null>(null);
  const [pinEdit, setPinEdit] = useState<AgentProfile | null>(null);
  const profiles = useProfiles();
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const settings = useStore((s) => s.settings);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const working = model.turn?.status === "working";
  const prefs = usePrefs();
  // Creator persona: plain-language composer, no model/agent jargon.
  const simple = (prefs.persona ? PERSONAS[prefs.persona].composer : "full") === "simple";
  const noModels = models.length === 0;

  // IME-safe input: the DOM owns live text; `text` tracks committed edits only.
  const inputRef = useRef<TextInputHandle>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const [text, setText] = useState(() => (session?.id ? loadDraft(session.id) : ""));
  const [focusMode, setFocusMode] = useState(false);
  const historyCursor = useRef(emptyPromptHistoryCursor());
  const applyingHistory = useRef(false);
  const historyItems = promptHistory(model.messages);
  const shell = shellCommand(text);
  const shellMode = shell !== null;

  // Session switch: restore the draft through the command handle (never a
  // controlled replay), and never while the user is mid-composition.
  useEffect(() => {
    sessionIdRef.current = session?.id ?? null;
    const t = session?.id ? loadDraft(session.id) : "";
    setText(t);
    inputRef.current?.replaceText(t);
    historyCursor.current = emptyPromptHistoryCursor();
  }, [session?.id]);

  // Debounced draft persistence of committed text.
  useEffect(() => {
    const id = session?.id;
    if (!id) return;
    const t = setTimeout(() => saveDraft(id, text), 250);
    return () => clearTimeout(t);
  }, [session?.id, text]);

  // Drag-and-drop: tree paths and desktop files become attachment pills.
  const [dropHint, setDropHint] = useState<"path" | "files" | null>(null);

  // Pending attachment pills live in the per-session draft store (F2).
  const attachments = usePendingAttachments(session?.id ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachFiles = useCallback((files: File[]) => {
    const projectId = getState().activeProjectId;
    if (!projectId || files.length === 0) return;
    const target = sessionIdRef.current;
    for (const f of files) {
      void attachUpload(projectId, target, f).then((r) => {
        if (!r.ok) setUiError(`Couldn’t attach ${f.name || "file"}: ${r.reason}`);
      });
    }
  }, []);

  // Paste: image/file clipboards become pills; a lone GitHub PR/issue URL
  // becomes a pill when the project's remote matches, else stays plain text.
  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const projectId = getState().activeProjectId;
    if (!projectId) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      attachFiles(files);
      return;
    }
    const pasted = e.clipboardData?.getData("text/plain") ?? "";
    if (!parseGithubUrl(pasted)) return;
    e.preventDefault();
    const target = sessionIdRef.current;
    void tryAttachGithubUrl(projectId, target, pasted).then((consumed) => {
      if (!consumed) inputRef.current?.insertText(pasted);
    });
  }, [attachFiles]);

  // Autocomplete state (token-based: works at any caret position)
  const [acItems, setAcItems] = useState<AutocompleteItem[]>(EMPTY_AC);
  const [acIndex, setAcIndex] = useState(0);
  const [acOpen, setAcOpen] = useState(false);
  const [acType, setAcType] = useState<"cmd" | "snip" | "file">("cmd");
  const acTokenRef = useRef<PromptToken | null>(null);
  const fileSearchSeq = useRef(0);

  // Explicit selections reset when the session changes (UX-30).
  useEffect(() => {
    setModelValue("");
    setAgentValue("");
    setProfileValue("");
  }, [session?.id]);

  // One-time favorites → profiles migration once models are known.
  useEffect(() => {
    if (models.length > 0) void migrateFavoritesOnce(models);
  }, [models]);

  // Auto-grow up to 40vh based on committed text.
  useEffect(() => {
    const el = inputRef.current?.element();
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
  // the event consumed; anything queued while unmounted drains now. Inserts go
  // through the command handle so an active composition is never interrupted.
  useEffect(() => {
    const insert = (detail: string) => {
      const h = inputRef.current;
      if (!h) return;
      const cur = h.getText();
      h.replaceText(cur ? `${cur} ${detail}` : detail);
    };
    for (const queued of drainInserts()) insert(queued);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      e.preventDefault();
      insert(detail);
      inputRef.current?.focus();
    };
    const replace = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      e.preventDefault();
      setText(detail);
      inputRef.current?.replaceText(detail);
      inputRef.current?.focus();
    };
    window.addEventListener(COMPOSER_INSERT, handler);
    window.addEventListener(COMPOSER_REPLACE, replace);
    return () => {
      window.removeEventListener(COMPOSER_INSERT, handler);
      window.removeEventListener(COMPOSER_REPLACE, replace);
    };
  }, []);

  const send = useCallback((override?: string) => {
    const t = (override ?? inputRef.current?.getText() ?? text).trim();
    const command = shellCommand(t);
    const hasPills = command === null && attachments.length > 0;
    if ((!t && !hasPills) || (command === null && noModels) || command === "") return;
    // Capture the target session at send time — project/session switches must
    // never reroute a send (delivery admission handles active turns server-side).
    const target = sessionIdRef.current;
    // Pills leave the draft the moment the message leaves the composer.
    const atts = command === null ? takeAttachments(target) : [];
    const delivery = working ? getUiSettings().followUpBehavior : undefined;
    const preferred = !session?.model ? parseModelRef(settings.defaultModel) : undefined;
    const deliver = (targetSessionId: string) => command !== null
      ? api.runShell(targetSessionId, command).catch(
          (err) => setUiError(`Couldn’t run shell command: ${err instanceof Error ? err.message : String(err)}`),
        )
      : sendMessage(
          t,
          modelRefFromValue(modelValue) ?? preferred,
          agentValue || undefined,
          {
            targetSessionId,
            ...(atts.length > 0 ? { attachments: atts } : {}),
            ...(delivery ? { delivery } : {}),
            dismissPending: true,
            ...(profileValue ? { agentProfileId: profileValue } : {}),
          },
        );
    if (target) {
      void deliver(target);
    } else if (activeProjectId) {
      void createSession(activeProjectId).then(() => {
        const created = getState().activeSessionId;
        if (created) return deliver(created);
      });
    }
    setText("");
    inputRef.current?.replaceText("");
    historyCursor.current = emptyPromptHistoryCursor();
    if (target) saveDraft(target, "");
    setAcOpen(false);
  }, [text, attachments, modelValue, agentValue, profileValue, noModels, working, activeProjectId, session?.model, settings.defaultModel]);

  const applyCompletion = useCallback((item: AutocompleteItem) => {
    const token = acTokenRef.current;
    const h = inputRef.current;
    if (!token || !h) return false;
    const cur = h.getText();
    const r = completeToken(cur, token, item.value);
    h.replaceText(r.text, { anchor: r.caret });
    setText(r.text);
    setAcOpen(false);
    h.focus();
    return true;
  }, []);

  const completeAutocomplete = useCallback(() => {
    if (!acOpen || acItems.length === 0) return false;
    const item = acItems[acIndex];
    if (!item) return false;
    return applyCompletion(item);
  }, [acOpen, acItems, acIndex, applyCompletion]);

  const onKeyIntercept = (e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean => {
    // IME composition: never send, never navigate autocomplete, never hotkey.
    if (composing) return false;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
      setFocusMode(true);
      return true;
    }
    if (acOpen) {
      if (e.key === "ArrowDown") {
        setAcIndex((i) => (i + 1) % acItems.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (completeAutocomplete()) return true;
      }
      if (e.key === "Escape") {
        setAcOpen(false);
        return true;
      }
    }
    const h = inputRef.current;
    const current = h?.getText() ?? text;
    const selection = h?.getSelection() ?? { start: 0, end: 0 };
    if (e.key === "ArrowUp" && (historyCursor.current.index !== null || (selection.start === 0 && selection.end === 0))) {
      const next = stepPromptHistory(historyItems, current, historyCursor.current, "up");
      historyCursor.current = next.cursor;
      applyingHistory.current = true;
      setText(next.text);
      h?.replaceText(next.text);
      return historyItems.length > 0;
    }
    if (e.key === "ArrowDown" && (historyCursor.current.index !== null || (selection.start === current.length && selection.end === current.length))) {
      const next = stepPromptHistory(historyItems, current, historyCursor.current, "down");
      historyCursor.current = next.cursor;
      applyingHistory.current = true;
      setText(next.text);
      h?.replaceText(next.text);
      return historyCursor.current.index !== null || next.text !== current;
    }
    if (e.key === "Escape" && historyCursor.current.index !== null) {
      const next = restorePromptHistoryDraft(current, historyCursor.current);
      historyCursor.current = next.cursor;
      applyingHistory.current = true;
      setText(next.text);
      h?.replaceText(next.text);
      return true;
    }
    if (e.key === "Enter") {
      if (e.metaKey || e.ctrlKey) {
        send();
        return true;
      }
      if (settings.sendOnEnter && !e.shiftKey) {
        send();
        return true;
      }
    }
    return false;
  };

  // Token-based autocomplete on committed text changes.
  const onTextChange = useCallback(
    (val: string) => {
      setText(val);
      if (!applyingHistory.current) historyCursor.current = emptyPromptHistoryCursor();
      applyingHistory.current = false;
      const caret = inputRef.current?.getSelection().end ?? val.length;
      const token = activeToken(val, caret);
      acTokenRef.current = token;
      if (!token) { setAcOpen(false); return; }
      if (token.kind === "command") {
        const items = filterCommands(commands, token.value);
        setAcItems(items);
        setAcType("cmd");
        setAcIndex(0);
        setAcOpen(items.length > 0);
        return;
      }
      if (token.kind === "snippet") {
        const items = filterSnippets(snippets, token.value);
        setAcItems(items);
        setAcType("snip");
        setAcIndex(0);
        setAcOpen(items.length > 0);
        return;
      }
      // file mention: scored search shared with the palette; folders included
      if (!activeProjectId || token.path.length < 1) { setAcOpen(false); return; }
      const seq = ++fileSearchSeq.current;
      void api.filesSearchScored(activeProjectId, token.path, 8, true).then((hits) => {
        if (seq !== fileSearchSeq.current) return; // stale
        const items = hits.map((h) => ({
          label: `@${h.path}`,
          detail: h.kind === "dir" ? "folder" : "file",
          value: `@${h.path}${h.kind === "dir" ? "/" : " "}`,
        }));
        setAcItems(items);
        setAcType("file");
        setAcIndex(0);
        setAcOpen(items.length > 0);
      });
    },
    [commands, snippets, activeProjectId],
  );

  const leading = renderSlot("composer.leading", { sessionId: session?.id });
  const trailing = renderSlot("composer.trailing", { sessionId: session?.id });

  // Favorites float first (Settings > Providers & Models); picking records recency.
  const modelPrefs = useModelPrefs();
  const preferredModel = parseModelRef(settings.defaultModel);
  const modelItems: PickerItem[] = [
    { id: "", label: modelPickerDefaultLabel(session?.model, models, preferredModel), group: "" },
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
    { id: "", label: agentPickerDefaultLabel(session?.agent, agents), group: "" },
    ...agents.map((a) => ({
      id: a.name,
      label: a.name,
      group: "",
      ...(a.description ? { detail: a.description } : {}),
    })),
  ];

  // Pin/Edit from the model row: exactly one matching profile opens Edit,
  // otherwise the form is seeded with the immutable provider/model pair.
  const pinModel = (value: string) => {
    const ref = modelRefFromValue(value);
    if (!ref) return;
    const matching = profiles.filter((p) => p.providerID === ref.providerID && p.modelID === ref.modelID);
    if (matching.length === 1) setPinEdit(matching[0]!);
    else {
      const m = models.find((x) => x.providerID === ref.providerID && x.modelID === ref.modelID);
      setPinSeed({ ...ref, name: m?.name || ref.modelID });
    }
  };
  const profileItems: PickerItem[] = [
    { id: "", label: "None", group: "" },
    ...profiles.map((p) => ({
      id: p.id,
      label: p.name,
      group: "",
      detail: `${p.providerID}/${p.modelID}${p.agent ? ` · ${p.agent}` : ""}`,
    })),
  ];

  const followUp = getUiSettings().followUpBehavior;
  const starterChips = (
    <div className="starter-chips" aria-label="Suggestions">
      {STARTERS.map((label) => (
        <button
          key={label}
          className="chip"
          onClick={() => {
            setText(label);
            inputRef.current?.replaceText(label);
            inputRef.current?.focus();
          }}
        >
          <span aria-hidden="true">✦</span>{label}
        </button>
      ))}
    </div>
  );

  return (
    <div className={variant === "hero" ? "composer-hero" : "composer"}>
      {variant === "docked" && <PendingChangesBar model={model} />}
      <div
        className="composer-card"
        onDragOver={(e) => { const k = dragKind(e.dataTransfer); if (k) { e.preventDefault(); setDropHint(k); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(null); }}
        onDrop={(e) => {
          const k = dragKind(e.dataTransfer);
          setDropHint(null);
          if (!k || !activeProjectId) return;
          e.preventDefault();
          void dropIntoSession(e.dataTransfer, activeProjectId, sessionIdRef.current,
            (reason) => setUiError(`Couldn’t attach: ${reason}`));
        }}
      >
      {dropHint && (
        <div className="drop-hint">{dropHint === "path" ? "Attach to chat" : "Drop to attach"}</div>
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
      {session?.id && <QueuedMessageList sessionId={session.id} />}
      {attachments.length > 0 && (
        <AttachmentPills
          attachments={attachments}
          onRemove={(id) => removeAttachment(session?.id ?? null, id)}
        />
      )}
      <div className="composer-input">
        {shellMode && <div className="composer-mode-label">Shell command · permission checked · output added to context</div>}
        <AdaptiveTextInput
          ref={inputRef}
          initialText={text}
          rows={3}
          className="composer-editor"
          ariaLabel="Message"
          placeholder={shellMode
            ? "Enter a workspace shell command…"
            : simple
            ? "Describe what you want — it gets built as you watch…"
            : "Ask Polyth to explore, build, or review — ! for shell, / for commands, # for snippets, @ for files"}
          onTextChange={onTextChange}
          onKeyIntercept={onKeyIntercept}
          onPaste={onPaste}
        />
        {acOpen && acItems.length > 0 && (
          <div className="ac-popup">
            <div className="ac-header">{acType === "cmd" ? "Commands" : acType === "snip" ? "Snippets" : "Files"}</div>
            <div className="ac-list" role="listbox" aria-label={acType === "cmd" ? "Commands" : acType === "snip" ? "Snippets" : "Files"}>
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
                    applyCompletion(item);
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
      {/* UX-A390 command surface: one composer, one send() path. The bar is
          three semantic groups — selectors, extension slots, actions — which
          stay on one row in wide mode and become the two-tier phone layout in
          CSS. No controller logic forks. */}
      <div className="composer-bar composer-row">
        <div className="composer-selectors">
          {!simple && !noModels && (
            <Picker
              className="picker-model"
              label="Model" direction="up" items={modelItems} value={modelValue} onPick={pickModel}
              trailingAction={{ label: "⚲", title: "Pin as profile (or edit the matching one)", onAction: pinModel }}
            />
          )}
          {!simple && agents.length > 0 && (
            <Picker className="picker-agent" label="Agent" direction="up" items={agentItems} value={agentValue} onPick={setAgentValue} />
          )}
          {!simple && profiles.length > 0 && (
            <Picker className="picker-profile" label="Profile" direction="up" items={profileItems} value={profileValue} onPick={setProfileValue} placeholder="None" />
          )}
        </div>
        <div className="composer-extensions">
          {leading.map((n, i) => <Fragment key={i}>{n}</Fragment>)}
          {trailing.map((n, i) => <Fragment key={i}>{n}</Fragment>)}
        </div>
        <div className="composer-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              attachFiles(files);
            }}
          />
          <button
            className="icon-btn composer-attach"
            title="Attach files"
            aria-label="Attach files"
            disabled={!activeProjectId}
            onClick={() => fileInputRef.current?.click()}
          >⊕</button>
          <button
            className="icon-btn composer-expand"
            title="Focused editor (Mod+Shift+Enter)"
            aria-label="Open focused editor"
            onClick={() => setFocusMode(true)}
          >⤢</button>
          <span className="composer-primary">
            {working ? (
              <>
                <button className="send composer-delivery" onClick={() => send()} disabled={(!text.trim() && attachments.length === 0) || (!shellMode && noModels)}
                  title={`Active turn — this message will ${followUp === "steer" ? "steer the current turn" : followUp === "interrupt" ? "interrupt, then send" : "queue until idle"}`}>
                  {shellMode ? "Run" : followUp === "steer" ? "Steer" : followUp === "interrupt" ? "Interrupt" : "Queue"} <span className="send-key">{settings.sendOnEnter ? "↵" : `${modKeyLabel()}↵`}</span>
                </button>
                <button className="stop" onClick={() => void abortSession()}>
                  Stop
                </button>
              </>
            ) : (
              <button className="send" onClick={() => send()} disabled={(!text.trim() && attachments.length === 0) || (!shellMode && noModels)}>
                {shellMode ? "Run" : "Send"} <span className="send-key">{settings.sendOnEnter ? "↵" : `${modKeyLabel()}↵`}</span>
              </button>
            )}
          </span>
        </div>
      </div>
      {focusMode && (
        <ComposerFocusDialog
          initialText={inputRef.current?.getText() ?? text}
          onCommit={(t) => {
            setText(t);
            inputRef.current?.replaceText(t);
          }}
          onClose={() => setFocusMode(false)}
          onSend={(t) => send(t)}
        />
      )}
      {(pinSeed || pinEdit) && (
        <AgentProfileForm
          {...(pinEdit ? { existing: pinEdit } : {})}
          {...(pinSeed ? { seed: pinSeed } : {})}
          lockModel
          onClose={() => { setPinSeed(null); setPinEdit(null); }}
          onSaved={(profile, use) => { if (use) setProfileValue(profile.id); }}
        />
      )}
      </div>
      {(variant === "hero" || (model.messages.length === 0 && !working)) && starterChips}
    </div>
  );
}
