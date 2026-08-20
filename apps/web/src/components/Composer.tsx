import { Fragment, useState, useRef, useEffect, useCallback, type ClipboardEvent, type KeyboardEvent } from "react";
import { getState, useActiveModel, useStore, setActiveView, setUiError, openSettingsPage } from "../store.ts";
import { sendMessage, abortSession, createSession } from "../init.ts";
import { api, type ComposerCatalogResult, type SlashCommand, type SnippetDef } from "../api.ts";
import { loadDraft, saveDraft, type AutocompleteItem } from "../utils.ts";
import { PERSONAS, usePrefs } from "../prefs.ts";
import { renderSlot } from "../slots.ts";
import { dragKind, dropIntoSession } from "../dnd.ts";
import {
  attachGithubLink, attachUpload, parseGithubUrl, removeAttachment, takeAttachments,
  tryAttachGithubUrl, usePendingAttachments, type GithubAttachResult,
} from "../attachments.ts";
import AttachmentPills from "./AttachmentPills.tsx";
import { COMPOSER_INSERT, COMPOSER_REPLACE, drainInserts } from "../composerInsert.ts";
import { activeToken, completeToken, shellCommand, type PromptToken } from "../composer/language.ts";
import {
  ATTACHMENT_COMPAT_NOTE,
  catalogFromResult,
  commandAutocomplete,
  fileAutocomplete,
  modelDetail,
  OPEN_PROJECT_FIRST,
  planCommandInsert,
  planShellEntry,
  planSigilInsert,
  snippetAutocomplete,
  type AutocompleteViewState,
  type CatalogState,
  type InsertPlan,
} from "../composer/discovery.ts";
import {
  loadComposerConfig, saveComposerConfig, consumeComposerConfig, wireProfileId,
  withExplicitAgent, withExplicitModel, withProfile, withProfileNone,
  type ComposerConfig,
} from "../composerConfig.ts";
import {
  emptyPromptHistoryCursor,
  promptHistory,
  restorePromptHistoryDraft,
  stepPromptHistory,
} from "../composer/history.ts";
import type { PickerItem } from "../picker.ts";
import Picker from "./Picker.tsx";
import AdaptiveTextInput, { type TextInputHandle } from "./input/AdaptiveTextInput.tsx";
import ComposerAddMenu from "./ComposerAddMenu.tsx";
import ComposerFocusDialog from "./ComposerFocusDialog.tsx";
import QueuedMessageList from "./QueuedMessageList.tsx";
import { GoalAttachForm } from "./GoalStrip.tsx";
import { announce } from "./a11y/live.tsx";
import { isFavorite, modelKey, sortModels } from "@polyth/models";
import { noteModelUsed, useModelPrefs } from "../modelPrefs.ts";
import { getUiSettings } from "../uiPrefs.ts";
import { migrateFavoritesOnce, profilesLoaded, useProfiles } from "../profiles.ts";
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

const STARTERS = [
  "Explore the codebase",
  "Review my recent changes",
  "Add tests",
  "Debug an issue",
  "Explain this project",
];

const PROFILE_MISSING_NOTE = "Profile unavailable — choose another";

export default function Composer({ variant = "docked" }: { variant?: "docked" | "hero" }) {
  const [pinSeed, setPinSeed] = useState<{ providerID: string; modelID: string; name?: string } | null>(null);
  const [pinEdit, setPinEdit] = useState<AgentProfile | null>(null);
  const [createProfileOpen, setCreateProfileOpen] = useState(false);
  const [goalFormOpen, setGoalFormOpen] = useState(false);
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
  const goalsEnabled = prefs.plugins.includes("goals");
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

  // UX-COMPOSER-DISC: one pending execution configuration (profile / model /
  // agent) per canonical session, persisted with the draft. Selections flow
  // through composerConfig transitions so profile and explicit overrides
  // clear each other.
  const [cfg, setCfg] = useState<ComposerConfig>(() => loadComposerConfig(session?.id ?? null));
  const updateCfg = useCallback((next: ComposerConfig) => {
    setCfg(next);
    saveComposerConfig(sessionIdRef.current, next);
  }, []);

  // Session switch: restore the draft through the command handle (never a
  // controlled replay), and never while the user is mid-composition. The
  // pending execution configuration is per-session and reloads with it.
  useEffect(() => {
    sessionIdRef.current = session?.id ?? null;
    const t = session?.id ? loadDraft(session.id) : "";
    setText(t);
    inputRef.current?.replaceText(t);
    historyCursor.current = emptyPromptHistoryCursor();
    setCfg(loadComposerConfig(session?.id ?? null));
    setAcToken(null);
    acTokenRef.current = null;
    fileSearchSeq.current++;
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

  // ---- capability catalogs (UX-COMPOSER-DISC) --------------------------------
  // Strict independent command/snippet outcomes; an HTTP failure is
  // `unavailable`, never a successful empty list.
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [catalog, setCatalog] = useState<ComposerCatalogResult | null>(null);
  const catalogSeq = useRef(0);

  useEffect(() => {
    const seq = ++catalogSeq.current;
    setCatalog(null);
    if (!activeProjectId) return;
    void api.composerCatalog(activeProjectId).then((r) => {
      if (seq === catalogSeq.current) setCatalog(r);
    });
  }, [activeProjectId]);

  const commandCatalog: CatalogState<SlashCommand> = !activeProjectId
    ? { state: "unavailable", reason: OPEN_PROJECT_FIRST }
    : catalogFromResult(catalog?.commands ?? null);
  const snippetCatalog: CatalogState<SnippetDef> = !activeProjectId
    ? { state: "unavailable", reason: OPEN_PROJECT_FIRST }
    : catalogFromResult(catalog?.snippets ?? null);

  // ---- token autocomplete -----------------------------------------------------
  // The active token is state so catalog transitions (loading → available)
  // re-derive the popup; Escape closes the popup but keeps the token text.
  const [acToken, setAcToken] = useState<PromptToken | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const acTokenRef = useRef<PromptToken | null>(null);
  const fileSearchSeq = useRef(0);
  const [fileSearch, setFileSearch] = useState<{ query: string; phase: "pending" | "done"; hits: Array<{ path: string; kind: "file" | "dir" }> }>(
    { query: "", phase: "done", hits: [] },
  );

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

  // A selected profile that was deleted after selection blocks Send with a
  // visible state; it is never silently substituted.
  const profileMissing = profilesLoaded()
    && cfg.profile.kind === "id"
    && !profiles.some((p) => cfg.profile.kind === "id" && p.id === cfg.profile.id);

  const send = useCallback((override?: string) => {
    const t = (override ?? inputRef.current?.getText() ?? text).trim();
    const command = shellCommand(t);
    const hasPills = command === null && attachments.length > 0;
    if ((!t && !hasPills) || (command === null && noModels) || command === "") return;
    if (command === null && profileMissing) return;
    // Capture the target session at send time — project/session switches must
    // never reroute a send (delivery admission handles active turns server-side).
    const target = sessionIdRef.current;
    // Pills leave the draft the moment the message leaves the composer.
    const atts = command === null ? takeAttachments(target) : [];
    const delivery = working ? getUiSettings().followUpBehavior : undefined;
    const preferred = !session?.model ? parseModelRef(settings.defaultModel) : undefined;
    const cfgSent = cfg;
    const wire = wireProfileId(cfgSent);
    const sentModel = cfgSent.model
      ? { providerID: cfgSent.model.providerID, modelID: cfgSent.model.modelID }
      : preferred;
    const deliver = (targetSessionId: string) => command !== null
      ? api.runShell(targetSessionId, command).catch(
          (err) => setUiError(`Couldn’t run shell command: ${err instanceof Error ? err.message : String(err)}`),
        )
      : sendMessage(
          t,
          sentModel,
          cfgSent.agent,
          {
            targetSessionId,
            ...(atts.length > 0 ? { attachments: atts } : {}),
            ...(delivery ? { delivery } : {}),
            dismissPending: true,
            ...(wire !== undefined ? { agentProfileId: wire } : {}),
          },
        ).then((ok) => {
          if (!ok) return;
          // The server recorded the sent configuration in the projection and
          // durable log; drop the local pending record only when it still
          // equals what was sent, then reflect the authoritative state.
          consumeComposerConfig(target, cfgSent);
          if (sessionIdRef.current === target) setCfg(loadComposerConfig(target));
        });
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
    setAcToken(null);
    acTokenRef.current = null;
  }, [text, attachments, cfg, profileMissing, noModels, working, activeProjectId, session?.model, settings.defaultModel]);

  const applyCompletion = useCallback((item: AutocompleteItem) => {
    const token = acTokenRef.current;
    const h = inputRef.current;
    if (!token || !h) return false;
    const cur = h.getText();
    const r = completeToken(cur, token, item.value);
    // replaceText fires onTextChange, which re-derives the token/popup state.
    h.replaceText(r.text, { anchor: r.caret });
    h.focus();
    return true;
  }, []);

  // ---- derived popup view (honest four-state projection) ----------------------
  const acView: AutocompleteViewState | null = (() => {
    if (!acToken) return null;
    if (acToken.kind === "command") return commandAutocomplete(commandCatalog, acToken.value);
    if (acToken.kind === "snippet") return snippetAutocomplete(snippetCatalog, acToken.value);
    if (!activeProjectId) return null;
    const fresh = fileSearch.query === acToken.path;
    return fileAutocomplete(
      acToken.path,
      fresh ? fileSearch.phase : "pending",
      fresh && fileSearch.phase === "done" ? fileSearch.hits : [],
    );
  })();
  const acOptions = acView?.options ?? [];
  const acSel = acOptions.length > 0 ? Math.min(acIndex, acOptions.length - 1) : -1;

  // One polite announcement per status transition — never per render and never
  // duplicating the active option name (aria-activedescendant covers that).
  const lastAnnounced = useRef<string | null>(null);
  const statusText = acView?.status?.text ?? null;
  useEffect(() => {
    if (statusText && statusText !== lastAnnounced.current) announce(statusText);
    lastAnnounced.current = statusText;
  }, [statusText]);

  const completeAutocomplete = (): boolean => {
    if (!acView || acOptions.length === 0) return false;
    const item = acOptions[acSel];
    if (!item) return false;
    return applyCompletion(item);
  };

  const onKeyIntercept = (e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean => {
    // IME composition: never send, never navigate autocomplete, never hotkey.
    if (composing) return false;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
      setFocusMode(true);
      return true;
    }
    if (acView) {
      // Arrows move the active descendant; Enter/Tab insert only when a
      // selectable option exists (Tab otherwise follows normal focus order).
      if (e.key === "ArrowDown" && acOptions.length > 0) {
        setAcIndex((i) => (i + 1) % acOptions.length);
        return true;
      }
      if (e.key === "ArrowUp" && acOptions.length > 0) {
        setAcIndex((i) => (i - 1 + acOptions.length) % acOptions.length);
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && acOptions.length > 0) {
        if (completeAutocomplete()) return true;
      }
      if (e.key === "Escape") {
        // Close the popup only; the token text and editor focus stay put.
        setAcToken(null);
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

  // Token-based autocomplete on committed text changes. File searches keep the
  // sequence guard: a project, session, token, or query change invalidates the
  // in-flight request, so a stale response never reopens or replaces results.
  const onTextChange = useCallback(
    (val: string) => {
      setText(val);
      if (!applyingHistory.current) historyCursor.current = emptyPromptHistoryCursor();
      applyingHistory.current = false;
      const caret = inputRef.current?.getSelection().end ?? val.length;
      const token = activeToken(val, caret);
      acTokenRef.current = token;
      setAcToken(token);
      setAcIndex(0);
      if (!token || token.kind !== "file") {
        fileSearchSeq.current++;
        return;
      }
      const q = token.path;
      const seq = ++fileSearchSeq.current;
      if (!activeProjectId || q.length === 0) {
        setFileSearch({ query: q, phase: "done", hits: [] });
        return;
      }
      setFileSearch({ query: q, phase: "pending", hits: [] });
      void api.filesSearchScored(activeProjectId, q, 8, true, getState().activeSessionId ?? undefined).then((hits) => {
        if (seq !== fileSearchSeq.current) return; // stale
        setFileSearch({ query: q, phase: "done", hits: hits.map((h) => ({ path: h.path, kind: h.kind })) });
      });
    },
    [activeProjectId],
  );

  // ---- Add menu insertions (through the IME-safe handle only) ----------------
  const applyPlan = useCallback((plan: InsertPlan) => {
    const h = inputRef.current;
    if (!h) return;
    h.replaceText(plan.text, { anchor: plan.caret });
    h.focus();
  }, []);
  const currentDraft = () => {
    const h = inputRef.current;
    const cur = h?.getText() ?? text;
    return { cur, caret: h?.getSelection().end ?? cur.length };
  };
  const menuMention = () => {
    const { cur, caret } = currentDraft();
    applyPlan(planSigilInsert(cur, caret, "@"));
  };
  const menuSnippet = () => {
    const { cur, caret } = currentDraft();
    applyPlan(planSigilInsert(cur, caret, "#"));
  };
  const menuCommand = () => {
    const { cur, caret } = currentDraft();
    applyPlan(planCommandInsert(cur, caret));
  };
  const menuShell = () => {
    // The menu row is disabled with a visible reason for nonempty drafts;
    // this guard keeps the rule even if activated programmatically.
    const plan = planShellEntry(inputRef.current?.getText() ?? text);
    if (plan.ok) applyPlan({ text: plan.text, caret: plan.caret });
  };
  const attachGithub = (url: string): Promise<GithubAttachResult> => {
    const projectId = getState().activeProjectId;
    if (!projectId) {
      return Promise.resolve({ ok: false, code: "no-repo", reason: OPEN_PROJECT_FIRST });
    }
    return attachGithubLink(projectId, sessionIdRef.current, url);
  };

  const leading = renderSlot("composer.leading", { sessionId: session?.id });
  const trailing = renderSlot("composer.trailing", { sessionId: session?.id });

  // ---- execution configuration projections ------------------------------------
  const modelValue = cfg.model
    ? JSON.stringify({ providerID: cfg.model.providerID, modelID: cfg.model.modelID })
    : "";
  const agentValue = cfg.agent ?? "";
  const selectedProfileId = cfg.profile.kind === "id"
    ? cfg.profile.id
    : cfg.profile.kind === "none"
    ? ""
    : (session?.agentProfileId ?? "");

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
        // Honest model detail: provider + numeric context + reported
        // connection only. No cost/modality/variant/attachment guesses.
        detail: modelDetail(m),
        keywords: [m.providerID, m.modelID],
      };
    }),
  ];
  const pickModel = (value: string) => {
    const ref = modelRefFromValue(value);
    updateCfg(withExplicitModel(cfg, ref));
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
  const pickAgent = (id: string) => updateCfg(withExplicitAgent(cfg, id || undefined));

  // Create/Edit profile from the model row: exactly one matching profile opens
  // Edit, otherwise the form is seeded with the immutable provider/model pair.
  const matchingProfiles = (ref: { providerID: string; modelID: string }) =>
    profiles.filter((p) => p.providerID === ref.providerID && p.modelID === ref.modelID);
  const pinModel = (value: string) => {
    const ref = modelRefFromValue(value);
    if (!ref) return;
    const matching = matchingProfiles(ref);
    if (matching.length === 1) setPinEdit(matching[0]!);
    else {
      const m = models.find((x) => x.providerID === ref.providerID && x.modelID === ref.modelID);
      setPinSeed({ ...ref, name: m?.name || ref.modelID });
    }
  };
  const modelRowAction = {
    labelFor: (id: string) => {
      const ref = modelRefFromValue(id);
      return ref && matchingProfiles(ref).length === 1 ? "Edit profile" : "Create profile";
    },
    nameFor: (id: string) => {
      const ref = modelRefFromValue(id);
      if (!ref) return "Create profile";
      const matching = matchingProfiles(ref);
      if (matching.length === 1) return `Edit profile ${matching[0]!.name}`;
      const m = models.find((x) => x.providerID === ref.providerID && x.modelID === ref.modelID);
      return `Create profile from ${m?.name || ref.modelID}`;
    },
    onAction: pinModel,
  };

  const noneLabel = simple ? "Default" : "None";
  const profileItems: PickerItem[] = [
    { id: "", label: noneLabel, group: "" },
    ...profiles.map((p) => ({
      id: p.id,
      label: p.name,
      group: "",
      detail: `${p.providerID}/${p.modelID}${p.agent ? ` · ${p.agent}` : ""}`,
    })),
  ];
  const pickProfile = (id: string) => {
    updateCfg(id ? withProfile(cfg, id) : withProfileNone(cfg));
  };
  const currentProfileName = profileMissing
    ? "Profile unavailable"
    : profiles.find((p) => p.id === selectedProfileId)?.name ?? noneLabel;
  // Creation needs a connectable model; the reason is visible text with an
  // operable settings route, never a silent hidden action.
  const profileFooter = (label: string) => ({
    label,
    run: () => setCreateProfileOpen(true),
    ...(noModels ? {
      disabledReason: "Connect a model before creating a profile",
      secondaryLabel: "Open model settings",
      secondaryRun: () => openSettingsPage("models"),
    } : {}),
  });

  const currentModelLabel = modelItems.find((i) => i.id === modelValue)?.label ?? modelItems[0]!.label;
  const currentAgentLabel = agentItems.find((i) => i.id === agentValue)?.label ?? agentItems[0]!.label;

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
      {profileMissing && (
        <div className="composer-note composer-profile-missing" role="alert">
          {PROFILE_MISSING_NOTE}
        </div>
      )}
      {session?.id && <QueuedMessageList sessionId={session.id} />}
      {attachments.length > 0 && (
        <AttachmentPills
          attachments={attachments}
          onRemove={(id) => removeAttachment(session?.id ?? null, id)}
        />
      )}
      {attachments.length > 0 && !simple && !noModels && (
        <div className="composer-attach-note">{ATTACHMENT_COMPAT_NOTE}</div>
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
          {...(acView ? {
            role: "combobox",
            ariaAutocomplete: "list" as const,
            ariaExpanded: true,
            ariaControls: "composer-autocomplete-list",
            ...(acSel >= 0 && acOptions[acSel] ? { ariaActiveDescendant: acOptions[acSel].id } : {}),
          } : {})}
          onTextChange={onTextChange}
          onKeyIntercept={onKeyIntercept}
          onPaste={onPaste}
        />
        {acView && (
          <div className="ac-popup">
            <div className="ac-header">{acView.kind === "cmd" ? "Commands" : acView.kind === "snip" ? "Snippets" : "Files"}</div>
            {acOptions.length > 0 ? (
              <div
                className="ac-list"
                id="composer-autocomplete-list"
                role="listbox"
                aria-label={acView.kind === "cmd" ? "Commands" : acView.kind === "snip" ? "Snippets" : "Files"}
              >
                {acOptions.map((item, i) => (
                  <div
                    key={item.id}
                    id={item.id}
                    role="option"
                    aria-selected={i === acSel}
                    ref={i === acSel ? (el) => el?.scrollIntoView({ block: "nearest" }) : null}
                    className={`ac-item ${i === acSel ? "ac-active" : ""}`}
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
            ) : (
              // Instructional / loading / empty / error body: the popup stays
              // open so the state is visible; Tab passes through normally.
              <div className="ac-status" id="composer-autocomplete-list">
                <span>{acView.status?.text}</span>
                {acView.status?.createSnippet && (
                  <button
                    type="button"
                    className="small-btn ac-create-snippet"
                    onClick={() => { setAcToken(null); openSettingsPage("commands"); }}
                  >
                    Create a snippet…
                  </button>
                )}
              </div>
            )}
            {acOptions.length > 0 && (
              <div className="ac-footer">
                <span><kbd>↑↓</kbd> navigate</span>
                <span><kbd>↵</kbd> / <kbd>Tab</kbd> insert</span>
                <span><kbd>Esc</kbd> dismiss</span>
              </div>
            )}
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
              ariaLabel={`Select model, current ${currentModelLabel}`}
              trailingAction={modelRowAction}
            />
          )}
          {!simple && agents.length > 0 && (
            <Picker
              className="picker-agent"
              label="Agent" direction="up" items={agentItems} value={agentValue} onPick={pickAgent}
              ariaLabel={`Select agent, current ${currentAgentLabel}`}
            />
          )}
          {/* Profile stays present at zero profiles; Creator renders the same
              store as `Setup` — one profile system, one send field. */}
          {!simple && (
            <Picker
              className="picker-profile"
              label="Profile" direction="up" items={profileItems} value={selectedProfileId} onPick={pickProfile}
              placeholder={profileMissing ? "Profile unavailable" : "None"}
              ariaLabel={`Select profile, current ${currentProfileName}`}
              footerAction={profileFooter("Create profile…")}
            />
          )}
          {simple && (
            <Picker
              className="picker-profile picker-setup"
              label="Setup" direction="up" items={profileItems} value={selectedProfileId} onPick={pickProfile}
              placeholder={profileMissing ? "Profile unavailable" : "Default"}
              ariaLabel={`Working setup (profile), current ${currentProfileName}`}
              footerAction={profileFooter("Create advanced setup…")}
            />
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
          <ComposerAddMenu
            hasProject={!!activeProjectId}
            hasSession={!!session?.id}
            goalsEnabled={goalsEnabled}
            draftText={text}
            commands={commandCatalog}
            snippets={snippetCatalog}
            direction={variant === "hero" ? "down" : "up"}
            onUpload={() => fileInputRef.current?.click()}
            onInsertMention={menuMention}
            onInsertCommand={menuCommand}
            onInsertSnippet={menuSnippet}
            onEnterShell={menuShell}
            onAttachGoal={() => setGoalFormOpen(true)}
            attachGithub={attachGithub}
          />
          <button
            className="icon-btn composer-expand"
            title="Focused editor (Mod+Shift+Enter)"
            aria-label="Open focused editor"
            onClick={() => setFocusMode(true)}
          >⤢</button>
          <span className="composer-primary">
            {working ? (
              <>
                <button className="send composer-delivery" onClick={() => send()}
                  disabled={(!text.trim() && attachments.length === 0) || (!shellMode && (noModels || profileMissing))}
                  aria-label={shellMode ? "Run shell command" : `${followUp === "steer" ? "Steer the current turn" : followUp === "interrupt" ? "Interrupt, then send" : "Queue until idle"}`}
                  title={`Active turn — this message will ${followUp === "steer" ? "steer the current turn" : followUp === "interrupt" ? "interrupt, then send" : "queue until idle"}`}>
                  {shellMode ? "Run" : followUp === "steer" ? "Steer" : followUp === "interrupt" ? "Interrupt" : "Queue"} <span className="send-key">{settings.sendOnEnter ? "↵" : `${modKeyLabel()}↵`}</span>
                </button>
                <button className="stop" onClick={() => void abortSession()}>
                  Stop
                </button>
              </>
            ) : (
              <button className="send" onClick={() => send()}
                disabled={(!text.trim() && attachments.length === 0) || (!shellMode && (noModels || profileMissing))}>
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
          onSaved={(profile, use) => { if (use) updateCfg(withProfile(cfg, profile.id)); }}
        />
      )}
      {createProfileOpen && (
        <AgentProfileForm
          onClose={() => setCreateProfileOpen(false)}
          onSaved={(profile, use) => { if (use) updateCfg(withProfile(cfg, profile.id)); }}
        />
      )}
      {goalFormOpen && <GoalAttachForm onDone={() => setGoalFormOpen(false)} />}
      </div>
      {(variant === "hero" || (model.messages.length === 0 && !working)) && starterChips}
    </div>
  );
}
