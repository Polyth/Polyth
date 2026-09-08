import { useLayoutEffect, useRef, useSyncExternalStore, type ReactElement } from "react";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import {
  EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { ResourceRef } from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";
import {
  peekDocument,
  registerDocumentEditorBridge,
} from "../../../apps/web/src/resources/documents.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { registerEditorSelection, type EditorSurfaceProps } from "../../../apps/web/src/resources/views.ts";
import { editorTheme } from "./theme.ts";
import { detectIndentUnit, languageOf, lineRangeFromOffsets, PLAIN_TEXT_LABEL } from "./languages.ts";

const SHELL_KEYS = new Set(["Mod-i"]);

interface EditorBinding {
  groupId: string;
  ref: ResourceRef;
  path: string;
  readOnly: boolean;
  wrap: boolean;
  ariaLabel?: string;
  onSave?: () => void;
  generation: number;
  languageTicket: number;
}

interface EditorGroup {
  id: string;
  view: EditorView;
  skip: boolean;
  active: EditorBinding | null;
  searchConfigured: boolean;
}

interface RetainedState {
  state: EditorState;
  generation: number;
  baseline: Text;
  searchConfigured: boolean;
}

const groups = new Map<string, EditorGroup>();
const states = new Map<string, RetainedState>();
const languageStatus = new Map<string, { label: string; fallback: boolean }>();
let languageStatusVersion = 0;
const languageStatusListeners = new Set<() => void>();

const wrapComp = new Compartment();
const readOnlyComp = new Compartment();
const languageComp = new Compartment();
const searchComp = new Compartment();
const syntaxComp = new Compartment();
const phrasesComp = new Compartment();
const labelComp = new Compartment();

let searchModule: Promise<typeof import("@codemirror/search")> | null = null;
let searchImportOverride: (() => Promise<typeof import("@codemirror/search")>) | null = null;
let searchImportFailOnce = false;
let languageLoadGate: Promise<void> | null = null;
let releaseLanguageLoadGate: (() => void) | null = null;
let languageTicketCounter = 0;

function bumpLanguageStatus(): void {
  languageStatusVersion++;
  for (const listener of [...languageStatusListeners]) listener();
}

function subscribeLanguageStatus(listener: () => void): () => void {
  languageStatusListeners.add(listener);
  return () => { languageStatusListeners.delete(listener);
  };
}

function phrases() {
  return EditorState.phrases.of({
    "Find": tr("editor.search.find"),
    "Replace": tr("editor.search.replace"),
    "next": tr("editor.search.next"),
    "previous": tr("editor.search.previous"),
    "all": tr("editor.search.all"),
    "match case": tr("editor.search.matchCase"),
    "regexp": tr("editor.search.regexp"),
    "by word": tr("editor.search.byWord"),
    "replace": tr("editor.search.replace"),
    "replace all": tr("editor.search.replaceAll"),
    "close": tr("editor.search.close"),
  });
}

function createState(doc: string, readOnly: boolean, wrap: boolean, ariaLabel?: string): EditorState {
  const unit = detectIndentUnit(doc);
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      EditorState.tabSize.of(unit === "\t" ? 4 : unit.length),
      keymap.of([
        {
          key: "Mod-s",
          run: () => true,
          preventDefault: true,
        },
        indentWithTab,
        ...defaultKeymap.filter((binding) => !SHELL_KEYS.has(binding.key ?? "")),
        ...historyKeymap,
      ]),
      wrapComp.of(wrap ? EditorView.lineWrapping : []),
      readOnlyComp.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      languageComp.of([]),
      searchComp.of([]),
      syntaxComp.of([]),
      phrasesComp.of(phrases()),
      labelComp.of(EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {})),
      editorTheme,
    ],
  });
}

function freshRetained(text: string, readOnly: boolean, wrap: boolean, ariaLabel?: string, generation = 0): RetainedState {
  const state = createState(text, readOnly, wrap, ariaLabel);
  return { state, generation, baseline: state.doc, searchConfigured: false };
}

function retainedKey(ref: ResourceRef): string {
  return resourceKey(ref);
}

function getOrCreateGroup(groupId: string): EditorGroup {
  let group = groups.get(groupId);
  if (group) return group;

  const view = new EditorView({
    state: createState("", false, true),
    dispatch: (tr, view) => {
      const group = groups.get(groupId);
      if (!group) return;
      const skip = group.skip;
      view.update([tr]);
      const active = group.active;
      if (!active) return;
      const key = retainedKey(active.ref);
      let retained = states.get(key);
      if (!retained) {
        retained = { state: view.state, generation: active.generation, baseline: view.state.doc, searchConfigured: false };
        states.set(key, retained);
      } else {
        retained.state = view.state;
      }
      if (!skip && tr.docChanged) {
        const equivalent = view.state.doc.eq(retained.baseline);
        peekDocument(active.ref)?.reportUserEdit(equivalent);
      }
    },
  });

  view.dom.addEventListener("keydown", (event) => {
    const group = groups.get(groupId);
    const active = group?.active;
    if (!active) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      active.onSave?.();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      void ensureSearch(group!);
    }
    if (event.key === "F3") {
      event.preventDefault();
      void ensureSearch(group!, true);
    }
  });
  view.dom.addEventListener("compositionstart", () => {
    const active = groups.get(groupId)?.active;
    if (active) peekDocument(active.ref)?.setComposing(true);
  });
  view.dom.addEventListener("compositionend", () => {
    const active = groups.get(groupId)?.active;
    if (active) peekDocument(active.ref)?.setComposing(false);
  });

  group = { id: groupId, view, skip: false, active: null, searchConfigured: false };
  groups.set(groupId, group);
  return group;
}

async function loadSearchModule(): Promise<typeof import("@codemirror/search")> {
  if (searchImportFailOnce) {
    searchImportFailOnce = false;
    throw new Error("search import failed");
  }
  if (searchImportOverride) return searchImportOverride();
  searchModule ??= import("@codemirror/search");
  return searchModule;
}

async function ensureSearch(group: EditorGroup, findNext = false): Promise<void> {
  const active = group.active;
  const retained = active ? states.get(retainedKey(active.ref)) : null;
  try {
    if (!retained?.searchConfigured) {
      const search = await loadSearchModule();
      group.view.dispatch({
        effects: searchComp.reconfigure([
          search.search({ top: true }),
          keymap.of(search.searchKeymap.filter((binding) => ["Mod-f", "F3", "Escape"].includes(binding.key ?? ""))),
        ]),
      });
      if (retained) retained.searchConfigured = true;
      group.searchConfigured = true;
      search.openSearchPanel(group.view);
      return;
    }
    const search = await loadSearchModule();
    if (findNext) search.findNext(group.view);
    else search.openSearchPanel(group.view);
  } catch {
    searchModule = null;
    group.searchConfigured = false;
    if (retained) retained.searchConfigured = false;
  }
}

function resolveRetained(
  ref: ResourceRef,
  readOnly: boolean,
  wrap: boolean,
  ariaLabel?: string,
): RetainedState {
  const key = retainedKey(ref);
  const handle = peekDocument(ref);
  const generation = handle?.getSnapshot().authoritativeGeneration ?? 0;
  const text = handle?.getBuffer() ?? "";
  const existing = states.get(key);
  if (!existing || existing.generation !== generation) {
    const fresh = freshRetained(text, readOnly, wrap, ariaLabel, generation);
    states.set(key, fresh);
    return fresh;
  }
  return existing;
}

function applyBindingToView(group: EditorGroup, binding: EditorBinding): void {
  const retained = resolveRetained(binding.ref, binding.readOnly, binding.wrap, binding.ariaLabel);
  if (group.view.state !== retained.state) {
    group.skip = true;
    group.view.setState(retained.state);
    group.skip = false;
    group.searchConfigured = retained.searchConfigured;
  }
  group.view.dispatch({
    effects: [
      wrapComp.reconfigure(binding.wrap ? EditorView.lineWrapping : []),
      readOnlyComp.reconfigure([
        EditorState.readOnly.of(binding.readOnly),
        EditorView.editable.of(!binding.readOnly),
      ]),
      phrasesComp.reconfigure(phrases()),
      labelComp.reconfigure(EditorView.contentAttributes.of(binding.ariaLabel ? { "aria-label": binding.ariaLabel } : {})),
    ],
  });
}

function bindingMatches(a: EditorBinding | null, b: EditorBinding): boolean {
  return a !== null
    && a.groupId === b.groupId
    && resourceKey(a.ref) === resourceKey(b.ref)
    && a.generation === b.generation;
}

function resetRetainedState(ref: ResourceRef, text: string, generation: number, readOnly = false, wrap = true): void {
  const key = retainedKey(ref);
  const fresh = freshRetained(text, readOnly, wrap, undefined, generation);
  states.set(key, fresh);
  for (const group of groups.values()) {
    if (group.active && resourceKey(group.active.ref) === key) {
      group.skip = true;
      group.view.setState(fresh.state);
      group.skip = false;
    }
  }
}

function updateBaseline(ref: ResourceRef, text: string): void {
  const key = retainedKey(ref);
  const retained = states.get(key);
  if (!retained) return;
  retained.baseline = retained.state.doc;
  if (retained.state.doc.toString() !== text) {
    const fresh = freshRetained(text, false, true, undefined, retained.generation);
    states.set(key, fresh);
    for (const group of groups.values()) {
      if (group.active && resourceKey(group.active.ref) === key) {
        group.skip = true;
        group.view.setState(fresh.state);
        group.skip = false;
      }
    }
  }
}

export function releaseEditorState(ref: ResourceRef): void {
  const key = retainedKey(ref);
  states.delete(key);
  languageStatus.delete(key);
  for (const group of groups.values()) {
    if (group.active && resourceKey(group.active.ref) === key) {
      group.active = null;
    }
  }
}

export function editorLanguageStatus(docKey: string): { label: string; fallback: boolean } {
  return languageStatus.get(docKey) ?? { label: PLAIN_TEXT_LABEL, fallback: false };
}

export function editorViewCount(): number {
  return groups.size;
}

export function editorGroupCount(): number {
  return groups.size;
}

export function editorActiveBinding(groupId: string): { ref: ResourceRef; generation: number } | null {
  const active = groups.get(groupId)?.active;
  if (!active) return null;
  return { ref: active.ref, generation: active.generation };
}

export function retainedStateCount(): number {
  return states.size;
}

export function resetEditorRuntimeForTest(): void {
  for (const group of groups.values()) group.view.destroy();
  groups.clear();
  states.clear();
  languageStatus.clear();
  languageStatusVersion = 0;
  searchModule = null;
  searchImportOverride = null;
  searchImportFailOnce = false;
  languageLoadGate = null;
  releaseLanguageLoadGate = null;
}

export function holdLanguageLoadsForTest(): void {
  languageLoadGate = new Promise<void>((resolve) => {
    releaseLanguageLoadGate = resolve;
  });
}

export function releaseLanguageLoadsForTest(): void {
  releaseLanguageLoadGate?.();
  languageLoadGate = null;
  releaseLanguageLoadGate = null;
}

export function setSearchImportForTest(
  override: (() => Promise<typeof import("@codemirror/search")>) | null,
  failOnce = false,
): void {
  searchImportOverride = override;
  searchImportFailOnce = failOnce;
  searchModule = null;
}

export function openSearchForTest(groupId: string): Promise<void> {
  const group = groups.get(groupId);
  if (!group) return Promise.resolve();
  return ensureSearch(group);
}

export function editorGroupSearchConfigured(groupId: string): boolean {
  const group = groups.get(groupId);
  if (!group?.active) return group?.searchConfigured === true;
  const retained = states.get(retainedKey(group.active.ref));
  return retained?.searchConfigured === true;
}

export function peekRetainedState(ref: ResourceRef): RetainedState | null {
  return states.get(retainedKey(ref)) ?? null;
}

export function editorSelection(docKey: string): { text: string; startLine: number; endLine: number } | null {
  const retained = states.get(docKey);
  const state = retained?.state;
  if (!state) return null;
  const main = state.selection.main;
  if (main.empty) return null;
  const from = Math.min(main.from, main.to);
  const to = Math.max(main.from, main.to);
  return {
    text: state.sliceDoc(from, to),
    ...lineRangeFromOffsets(
      (offset) => state.doc.lineAt(offset).number,
      (offset) => state.doc.sliceString(offset, offset + 1),
      from,
      to,
      state.doc.length,
    ),
  };
}

registerDocumentEditorBridge({
  onAuthoritativeReset(ref, text, generation) {
    resetRetainedState(ref, text, generation);
  },
  onSavedClean(ref, text) {
    updateBaseline(ref, text);
  },
  onDocumentDeleted(ref) {
    releaseEditorState(ref);
  },
  onDocumentMoved(from, to) {
    const fromKey = retainedKey(from);
    const toKey = retainedKey(to);
    const retained = states.get(fromKey);
    const lang = languageStatus.get(fromKey);
    if (retained) {
      states.delete(fromKey);
      states.set(toKey, retained);
    }
    if (lang) {
      languageStatus.delete(fromKey);
      languageStatus.set(toKey, lang);
      bumpLanguageStatus();
    }
    for (const group of groups.values()) {
      if (group.active && resourceKey(group.active.ref) === fromKey) {
        group.active = { ...group.active, ref: to, path: to.locator, languageTicket: ++languageTicketCounter };
      }
    }
  },
});

export default function EditorRuntime(props: EditorSurfaceProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const bindingRef = useRef<EditorBinding | null>(null);
  const docKey = resourceKey(props.resource);

  const languageLabel = useSyncExternalStore(
    subscribeLanguageStatus,
    () => editorLanguageStatus(docKey).label,
    () => PLAIN_TEXT_LABEL,
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handle = peekDocument(props.resource);
    const generation = handle?.getSnapshot().authoritativeGeneration ?? 0;
    const binding: EditorBinding = {
      groupId: props.groupId,
      ref: props.resource,
      path: props.path,
      readOnly: props.readOnly === true,
      wrap: props.wrap !== false,
      ariaLabel: props.ariaLabel,
      onSave: props.onSave,
      generation,
      languageTicket: ++languageTicketCounter,
    };
    bindingRef.current = binding;

    if (!props.visible) {
      const group = groups.get(props.groupId);
      if (group && bindingMatches(group.active, binding)) {
        states.set(docKey, { state: group.view.state, generation, baseline: states.get(docKey)?.baseline ?? group.view.state.doc, searchConfigured: states.get(docKey)?.searchConfigured ?? false });
        if (group.view.dom.parentElement === host) host.removeChild(group.view.dom);
        handle?.detachSource();
        group.active = null;
      }
      return;
    }

    const group = getOrCreateGroup(props.groupId);
    group.active = binding;
    if (group.view.dom.parentElement !== host) {
      if (group.view.dom.parentElement) group.view.dom.parentElement.removeChild(group.view.dom);
      host.appendChild(group.view.dom);
    }

    applyBindingToView(group, binding);
    states.set(docKey, states.get(docKey) ?? { state: group.view.state, generation, baseline: group.view.state.doc, searchConfigured: false });

    const existingSource = handle?.getSnapshot();
    if (handle) {
      handle.attachSource({
        getText: () => {
          const active = groups.get(props.groupId)?.active;
          if (!active || resourceKey(active.ref) !== docKey) {
            return states.get(docKey)?.state.doc.toString() ?? "";
          }
          const retained = states.get(docKey);
          return (groups.get(props.groupId)?.view.state ?? retained?.state)?.doc.toString() ?? "";
        },
        resetAuthoritative: (text) => {
          const snap = peekDocument(props.resource)?.getSnapshot();
          resetRetainedState(props.resource, text, snap?.authoritativeGeneration ?? generation, binding.readOnly, binding.wrap);
        },
      });
    }

    if (props.reveal) {
      const doc = group.view.state.doc;
      const startLine = Math.min(Math.max(1, props.reveal.startLine), doc.lines);
      const endLine = Math.min(Math.max(startLine, props.reveal.endLine), doc.lines);
      group.view.dispatch({
        selection: { anchor: doc.line(startLine).from, head: doc.line(endLine).to },
        scrollIntoView: true,
      });
      props.onRevealConsumed?.();
    }

    const language = languageOf(props.path);
    const ticket = `${props.groupId}:${docKey}:${generation}:${binding.languageTicket}`;
    void (async () => {
      if (languageLoadGate) await languageLoadGate;
      const extension = language ? await language.load() : [];
      const active = groups.get(props.groupId)?.active;
      const currentTicket = active
        ? `${active.groupId}:${resourceKey(active.ref)}:${active.generation}:${active.languageTicket}`
        : "";
      if (currentTicket !== ticket) return;
      try {
        const syntax = language ? (await import("./syntaxTheme.ts")).editorHighlight : [];
        languageStatus.set(docKey, { label: language?.label ?? PLAIN_TEXT_LABEL, fallback: false });
        bumpLanguageStatus();
        group.view.dispatch({
          effects: [languageComp.reconfigure(extension), syntaxComp.reconfigure(syntax)],
        });
      } catch {
        languageStatus.set(docKey, { label: `${language?.label ?? PLAIN_TEXT_LABEL} · ${PLAIN_TEXT_LABEL}`, fallback: true });
        bumpLanguageStatus();
        group.view.dispatch({
          effects: [languageComp.reconfigure([]), syntaxComp.reconfigure([])],
        });
      }
    })().catch(() => {
      languageStatus.set(docKey, { label: `${language?.label ?? PLAIN_TEXT_LABEL} · ${PLAIN_TEXT_LABEL}`, fallback: true });
      bumpLanguageStatus();
    });

    props.onReady?.();

    return () => {
      const current = bindingRef.current;
      const g = groups.get(props.groupId);
      if (!g || !current) return;
      const key = retainedKey(current.ref);
      states.set(key, {
        state: g.view.state,
        generation: current.generation,
        baseline: states.get(key)?.baseline ?? g.view.state.doc,
        searchConfigured: states.get(key)?.searchConfigured ?? false,
      });
      if (bindingMatches(g.active, current)) {
        peekDocument(current.ref)?.detachSource();
        g.active = null;
      }
      if (g.view.dom.parentElement === host) host.removeChild(g.view.dom);
    };
  }, [
    props.groupId,
    props.resource,
    props.visible,
    props.path,
    props.readOnly,
    props.wrap,
    props.ariaLabel,
    props.onSave,
    props.onReady,
    props.reveal,
    props.onRevealConsumed,
    docKey,
  ]);

  return <div className="editor-code" ref={hostRef} data-language={languageLabel} />;
}

registerEditorSelection(editorSelection);
