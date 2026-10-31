import { useLayoutEffect, useRef, useSyncExternalStore, type ReactElement } from "react";
import { Compartment, EditorState, RangeSetBuilder, Text, type Extension, type Text as CMText } from "@codemirror/state";
import {
  EditorView, drawSelection, dropCursor, GutterMarker, gutter, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, hoverTooltip, keymap, lineNumbers, rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap,
  type Completion, type CompletionSource,
} from "@codemirror/autocomplete";
import { lintGutter, linter, type Diagnostic as CMDiagnostic, type LintSource } from "@codemirror/lint";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import type { ResourceRef } from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";
import {
  editorIntelligenceProvidersFor,
  subscribeEditorIntelligence,
  type EditorIntelligenceProvider,
  type EditorIntelligenceRequest,
} from "./intelligence.ts";
import {
  peekDocument,
  registerDocumentEditorBridge,
} from "../../../apps/web/src/resources/documents.ts";
import { subscribeLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  registerEditorReplace,
  registerEditorSelection,
  reportEditorCursor,
  getEditorCursor,
  type EditorChangeSet,
  type EditorSurfaceProps,
} from "../../../apps/web/src/resources/views.ts";
import { editorTheme } from "./theme.ts";
import { changeMarksExtension, changeMarksKey, setChangeMarks } from "./changeMarks.ts";
import { detectIndentUnit, languageLabelOf, languageOf, lineRangeFromOffsets } from "./languages.ts";
import { requestEditorLanguage } from "./languageClient.ts";
import type { EditorCompletionItem, EditorDiagnostic, EditorPosition } from "../src/languageTypes.ts";
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
  ownsSource: boolean;
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
  baseline: CMText;
  searchConfigured: boolean;
  readOnly: boolean;
  wrap: boolean;
  ariaLabel?: string;
}

const groups = new Map<string, EditorGroup>();
/** Latest owner-supplied change set per document (EditorSurfaceProps.changes). */
const latestChanges = new Map<string, EditorChangeSet | null>();

/** Apply the document's latest change set to the group showing it. A set is
 *  drawn only over the exact text it describes; while the buffer differs
 *  (unsaved typing) the previous marks stay, mapped through the edits. */
function applyChangeMarks(group: EditorGroup, docKey: string): void {
  if (!latestChanges.has(docKey)) return;
  const set = latestChanges.get(docKey) ?? null;
  const active = group.active;
  if (!active || resourceKey(active.ref) !== docKey) return;
  const state = group.view.state;
  const current = changeMarksKey(state);
  if (set === null) {
    if (current !== null) group.view.dispatch({ effects: setChangeMarks.of(null) });
    return;
  }
  if (current === set.key) return;
  if (state.doc.length !== set.baseText.length || state.doc.toString() !== set.baseText) return;
  group.view.dispatch({ effects: setChangeMarks.of(set) });
}

function reportGroupCursor(group: EditorGroup): void {
  if (!group.active) return;
  const position = group.view.state.selection.main.head;
  const line = group.view.state.doc.lineAt(position);
  reportEditorCursor(group.active.ref, { line: line.number, column: position - line.from + 1 });
}
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
const gitGutterComp = new Compartment();
const completionComp = new Compartment();
const intelligenceComp = new Compartment();

let searchModule: Promise<typeof import("@codemirror/search")> | null = null;
let searchImportOverride: (() => Promise<typeof import("@codemirror/search")>) | null = null;
let searchImportFailOnce = false;
let languageLoadGate: Promise<void> | null = null;
let releaseLanguageLoadGate: (() => void) | null = null;
let languageTicketCounter = 0;

interface GitHunkMarkerData {
  projectId: string;
  sessionId: string | null;
  repositoryId: string;
  path: string;
  hunkIndex: number;
  hunkDigest: string;
  expectedSnapshotDigest: string;
  expectedStaged: boolean;
}

class GitHunkMarker extends GutterMarker {
  private readonly data: GitHunkMarkerData;
  constructor(data: GitHunkMarkerData) {
    super();
    this.data = data;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof GitHunkMarker && JSON.stringify(other.data) === JSON.stringify(this.data);
  }
  toDOM(): Node {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "editor-git-hunk-marker";
    node.title = "Show changed lines";
    node.setAttribute("aria-label", "Show changed lines");
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dispatchEditorEvent("polyth:editor-git-hunk", this.data);
    });
    return node;
  }
}

function hunkDigest(body: string): string {
  let hash = 0x811c9dc5;
  const text = body.split("\n").filter((line) => !line.startsWith("\\ No newline at end of file")).join("\n");
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function gitMarkers(view: EditorView, diff: string, data: Omit<GitHunkMarkerData, "hunkIndex" | "hunkDigest">): RangeSetBuilder<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const lines = diff.split("\n");
  let hunkIndex = 0;
  for (let index = 0; index < lines.length; index++) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[index] ?? "");
    if (!match) continue;
    const startLine = Math.max(1, Number(match[1]));
    const bodyStart = index + 1;
    let end = bodyStart;
    while (end < lines.length && !lines[end]!.startsWith("@@ ")) end++;
    const line = view.state.doc.line(Math.min(startLine, view.state.doc.lines));
    builder.add(line.from, line.from, new GitHunkMarker({
      ...data,
      hunkIndex,
      hunkDigest: hunkDigest(lines.slice(bodyStart, end).join("\n")),
    }));
    hunkIndex++;
    index = end - 1;
  }
  return builder;
}

async function loadGitGutter(group: EditorGroup, binding: EditorBinding): Promise<void> {
  if (binding.ref.scheme !== "file") return;
  const controller = new AbortController();
  try {
    const query = new URLSearchParams({
      projectId: binding.ref.projectId,
      path: binding.path,
      ...(binding.ref.sessionId ? { sessionId: binding.ref.sessionId } : {}),
      repositoryId: binding.ref.repositoryId ?? "primary",
    });
    const response = await fetch(`/api/git/diff?${query}`, { signal: controller.signal });
    if (!response.ok) return;
    const result = await response.json() as { diff?: unknown; snapshotDigest?: unknown };
    if (typeof result.diff !== "string" || typeof result.snapshotDigest !== "string") return;
    const active = groups.get(binding.groupId)?.active;
    if (!active || !bindingMatches(active, binding)) return;
    group.view.dispatch({ effects: gitGutterComp.reconfigure(gutter({
      class: "editor-git-gutter",
      markers: (view) => gitMarkers(view, result.diff as string, {
        projectId: binding.ref.projectId,
        sessionId: binding.ref.sessionId,
        repositoryId: binding.ref.repositoryId ?? "primary",
        path: binding.path,
        expectedSnapshotDigest: result.snapshotDigest as string,
        expectedStaged: false,
      }).finish(),
    })) });
  } catch {
    // Git is optional for a file editor. A missing provider or a stale hidden
    // view leaves the editor usable and simply removes the gutter markers.
  } finally {
    controller.abort();
  }
}

function editorPosition(view: EditorView, offset: number): EditorPosition {
  const line = view.state.doc.lineAt(Math.max(0, Math.min(offset, view.state.doc.length)));
  return { line: line.number - 1, character: Math.max(0, offset - line.from) };
}

function currentOverlay(binding: EditorBinding): { content?: string } {
  const handle = peekDocument(binding.ref);
  const content = handle?.getBuffer();
  if (typeof content !== "string") return {};
  return { content };
}

function dispatchEditorEvent(name: string, detail: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function goToDefinition(group: EditorGroup, position = group.view.state.selection.main.head): Promise<void> {
  const active = group.active;
  if (!active || active.ref.scheme !== "file") return;
  const requestedDocument = group.view.state.doc;
  const result = await requestEditorLanguage({
    capability: "definition",
    projectId: active.ref.projectId,
    sessionId: active.ref.sessionId,
    repositoryId: active.ref.repositoryId ?? "primary",
    path: active.path,
    position: editorPosition(group.view, position),
    ...currentOverlay(active),
  }).catch(() => null);
  if (group.active !== active || group.view.state.doc !== requestedDocument || !result?.definitions?.length) return;
  if (result.definitions.length === 1) {
    const definition = result.definitions[0]!;
    dispatchEditorEvent("polyth:editor-open", {
      projectId: definition.projectId,
      sessionId: definition.sessionId,
      repositoryId: definition.repositoryId,
      path: definition.path,
      reveal: { startLine: definition.range.start.line + 1, endLine: definition.range.end.line + 1 },
    });
    return;
  }
  dispatchEditorEvent("polyth:editor-definition-list", { definitions: result.definitions });
}

function contextDetails(group: EditorGroup, position: number): Record<string, unknown> | null {
  const active = group.active;
  if (!active || active.ref.scheme !== "file") return null;
  const main = group.view.state.selection.main;
  const from = Math.min(main.from, main.to);
  const to = Math.max(main.from, main.to);
  const start = editorPosition(group.view, from);
  const end = editorPosition(group.view, to);
  return {
    projectId: active.ref.projectId,
    sessionId: active.ref.sessionId,
    repositoryId: active.ref.repositoryId ?? "primary",
    path: active.path,
    position: editorPosition(group.view, position),
    selection: group.view.state.sliceDoc(from, to),
    ...currentOverlay(active),
    startLine: start.line + 1,
    endLine: end.line + 1,
    actions: ["definition", "peek", "references", "rename", "ask", "attach", "copy"],
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("polyth:editor-command", (event) => {
    const detail = (event as CustomEvent).detail as { action?: string; resource?: ResourceRef; projectId?: string; sessionId?: string | null; repositoryId?: string; path?: string } | undefined;
    const action = detail?.action;
    const visible = [...groups.values()].filter((candidate) => candidate.active);
    const target = detail?.resource ?? (detail?.projectId && detail.path
      ? { scheme: "file", projectId: detail.projectId, sessionId: detail.sessionId ?? null, repositoryId: detail.repositoryId, locator: detail.path }
      : getEditorCursor()?.resource);
    const group = target
      ? visible.find((candidate) => resourceKey(candidate.active!.ref) === resourceKey(target))
      : visible.find((candidate) => candidate.view.hasFocus);
    if (!group) return;
    if (action === "definition") {
      void goToDefinition(group);
      return;
    }
    if (action === "find") {
      void ensureSearch(group);
      return;
    }
    if (action === "peek" || action === "references" || action === "rename") {
      const detail = contextDetails(group, group.view.state.selection.main.head);
      if (detail) dispatchEditorEvent("polyth:editor-context-menu", { ...detail, x: 0, y: 0, command: action });
    }
  });
}

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

function reconfigureLivePhrases(): void {
  for (const group of groups.values()) {
    group.skip = true;
    group.view.dispatch({ effects: phrasesComp.reconfigure(phrases()) });
    group.skip = false;
  }
}

subscribeLocale(reconfigureLivePhrases);

/** A provider registration change re-configures every mounted buffer: a
 *  contribution that appears or disappears must take effect immediately. */
function reconfigureIntelligence(): void {
  for (const group of groups.values()) {
    const active = group.active;
    if (!active) continue;
    const language = languageLabelOf(active.path);
    group.view.dispatch({
      effects: [
        completionComp.reconfigure(completionExtensions(active.readOnly, providerCompletionSources(group.id, language))),
        intelligenceComp.reconfigure(intelligenceExtensions(group.id, language, active.readOnly)),
      ],
    });
  }
}

subscribeEditorIntelligence(reconfigureIntelligence);

/** Completion support for an editable buffer. Language-provided sources
 *  (JS/TS scope+keywords, JSON, YAML, ...) come in through language data; the
 *  document-word source is the fallback for every language. When a code
 *  intelligence provider serves the buffer's language its sources replace
 *  both: the same name from a word list and from the language service would
 *  otherwise be offered twice. Read-only editors get no source, no popup and
 *  no completion keybindings, so a completion can never open there. */
function completionExtensions(readOnly: boolean, providerSources: readonly CompletionSource[] = []) {
  if (readOnly) return [];
  return [
    providerSources.length > 0
      ? autocompletion({ activateOnTyping: true, override: [...providerSources] })
      : autocompletion({ activateOnTyping: true }),
    ...(providerSources.length > 0 ? [] : [EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }])]),
    keymap.of([...closeBracketsKeymap, ...completionKeymap]),
  ];
}

/** CodeMirror offers an icon vocabulary; the provider's language-service kind
 *  is mapped onto it (a kind without a dedicated glyph falls back to text). */
const COMPLETION_TYPES: Readonly<Record<string, string>> = {
  keyword: "keyword",
  variable: "variable",
  constant: "constant",
  function: "function",
  method: "method",
  property: "property",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  module: "namespace",
  text: "text",
};

function offsetAt(state: EditorState, position: EditorPosition): number {
  const lineNumber = Math.min(Math.max(1, position.line + 1), state.doc.lines);
  const line = state.doc.line(lineNumber);
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

function editorPositionAt(state: EditorState, offset: number): EditorPosition {
  const line = state.doc.lineAt(Math.max(0, Math.min(offset, state.doc.length)));
  return { line: line.number - 1, character: Math.max(0, offset - line.from) };
}

function intelligenceRequest(
  binding: EditorBinding,
  language: string,
  position: EditorPosition,
  content: string,
  contentRevision?: string,
): EditorIntelligenceRequest {
  return {
    ref: binding.ref,
    path: binding.path,
    language,
    content,
    ...(contentRevision === undefined ? {} : { contentRevision }),
    position,
  };
}


/** One abort controller per group and capability: a new request cancels the
 *  previous in-flight one so a slow provider cannot answer into a buffer that
 *  has already moved on. */
const inFlight = new Map<string, AbortController>();

function nextSignal(key: string): AbortSignal {
  inFlight.get(key)?.abort();
  const controller = new AbortController();
  inFlight.set(key, controller);
  return controller.signal;
}

/** Run an untrusted capability: a provider that throws synchronously, returns
 *  a non-promise or rejects must never escape into CodeMirror. */
function askProvider<T>(call: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return Promise.resolve(call()).catch(() => fallback);
  } catch {
    return Promise.resolve(fallback);
  }
}

function completionOptions(items: readonly EditorCompletionItem[]): Completion[] {
  const valid = items.filter((item) => typeof item === "object" && item !== null
    && typeof item.label === "string" && item.label.length > 0);
  // `sortText` is the language service's ordering key; CodeMirror ranks by
  // `boost` (higher first), so the first sortText key gets the highest boost.
  const ranked = valid
    .map((item, index) => ({ index, key: item.sortText ?? item.label }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  const boost = new Map(ranked.map((entry, rank) => [entry.index, ranked.length - rank]));
  return valid.map((item, index) => ({
    label: item.label,
    type: COMPLETION_TYPES[item.kind] ?? "text",
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    apply: item.insertText ?? item.label,
    boost: boost.get(index) ?? 0,
  }));
}

function completionSource(groupId: string, provider: EditorIntelligenceProvider): CompletionSource {
  return async (context) => {
    const active = groups.get(groupId)?.active;
    if (!active || typeof provider.completions !== "function") return null;
    // Ask the service only where a completion can start (a word or a member
    // access) or when the person asked; every request uploads the buffer.
    if (!context.explicit && !context.matchBefore(/[\w$]+$/) && !context.matchBefore(/\.$/)) return null;
    const signal = nextSignal(`${groupId}:${provider.id}:completion`);
    const request = intelligenceRequest(
      active,
      languageLabelOf(active.path),
      editorPositionAt(context.state, context.pos),
      context.state.doc.toString(),
    );
    const result = await askProvider(() => provider.completions!(request, signal), null);
    if (!result || !Array.isArray(result.items) || result.items.length === 0) return null;
    const state = groups.get(groupId)?.view.state;
    if (!state) return null;
    const from = Math.min(offsetAt(state, result.from), context.pos);
    return {
      from: Math.max(0, from),
      options: completionOptions(result.items),
      validFor: /^\w*$/,
    };
  };
}

function hoverSource(groupId: string, provider: EditorIntelligenceProvider): Parameters<typeof hoverTooltip>[0] {
  return async (view, pos) => {
    const active = groups.get(groupId)?.active;
    if (!active || typeof provider.hover !== "function") return null;
    const signal = nextSignal(`${groupId}:${provider.id}:hover`);
    const request = intelligenceRequest(
      active,
      languageLabelOf(active.path),
      editorPositionAt(view.state, pos),
      view.state.doc.toString(),
    );
    const result = await askProvider(() => provider.hover!(request, signal), null);
    if (!result || typeof result.display !== "string") return null;
    const start = offsetAt(view.state, result.range.start);
    const end = offsetAt(view.state, result.range.end);
    return {
      pos: start,
      end: Math.max(start, end),
      create: () => {
        const dom = document.createElement("div");
        dom.className = "editor-intelligence-hover";
        const display = document.createElement("div");
        display.className = "editor-intelligence-hover-display";
        // Plain text only: a language service documents code, it never ships markup.
        display.textContent = result.display;
        dom.appendChild(display);
        if (result.documentation) {
          const documentation = document.createElement("div");
          documentation.className = "editor-intelligence-hover-documentation";
          documentation.textContent = result.documentation;
          dom.appendChild(documentation);
        }
        return { dom };
      },
    };
  };
}

function lintSource(groupId: string, provider: EditorIntelligenceProvider): LintSource {
  return async (view) => {
    const active = groups.get(groupId)?.active;
    if (!active || typeof provider.diagnostics !== "function") return [];
    const signal = nextSignal(`${groupId}:${provider.id}:diagnostics`);
    const request = intelligenceRequest(
      active,
      languageLabelOf(active.path),
      editorPositionAt(view.state, view.state.selection.main.head),
      view.state.doc.toString(),
    );
    const result = await askProvider(() => provider.diagnostics!(request, signal), [] as EditorDiagnostic[]);
    const diagnostics: CMDiagnostic[] = [];
    for (const diagnostic of Array.isArray(result) ? result : []) {
      if (!diagnostic?.range?.start || !diagnostic.range.end) continue;
      const from = offsetAt(view.state, diagnostic.range.start);
      const to = offsetAt(view.state, diagnostic.range.end);
      diagnostics.push({
        from,
        to: Math.max(from, to),
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: provider.id,
        ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
      });
    }
    return diagnostics;
  };
}

/** Completion sources of the providers serving `language` (they take over the
 *  buffer's completion list, completionExtensions). */
function providerCompletionSources(groupId: string, language: string): CompletionSource[] {
  return editorIntelligenceProvidersFor(language)
    .filter((provider) => typeof provider.completions === "function")
    .map((provider) => completionSource(groupId, provider));
}

/** Hover and diagnostics are additive extensions; completions go through
 *  completionExtensions. A read-only buffer never gets completions. */
function intelligenceExtensions(groupId: string, language: string, _readOnly: boolean): Extension[] {
  const providers = editorIntelligenceProvidersFor(language);
  if (providers.length === 0) return [];
  const hovers = providers.filter((provider) => typeof provider.hover === "function");
  const linters = providers.filter((provider) => typeof provider.diagnostics === "function");
  const extensions: Extension[] = [];
  for (const provider of hovers) extensions.push(hoverTooltip(hoverSource(groupId, provider), { hoverTime: 350 }));
  if (linters.length > 0) {
    for (const provider of linters) extensions.push(linter(lintSource(groupId, provider), { delay: 750 }));
    extensions.push(lintGutter());
  }
  return extensions;
}

function createState(doc: string, readOnly: boolean, wrap: boolean, ariaLabel?: string): EditorState {
  const unit = detectIndentUnit(doc);
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      foldGutter(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      completionComp.of(completionExtensions(readOnly)),
      intelligenceComp.of([]),
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
        ...foldKeymap,
      ]),
      wrapComp.of(wrap ? EditorView.lineWrapping : []),
      readOnlyComp.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      languageComp.of([]),
      searchComp.of([]),
      syntaxComp.of([]),
      gitGutterComp.of([]),
      changeMarksExtension,
      phrasesComp.of(phrases()),
      labelComp.of(EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {})),
      editorTheme,
    ],
  });
}

function freshRetained(
  text: string,
  readOnly: boolean,
  wrap: boolean,
  ariaLabel?: string,
  generation = 0,
  searchConfigured = false,
): RetainedState {
  const state = createState(text, readOnly, wrap, ariaLabel);
  return {
    state,
    generation,
    baseline: state.doc,
    searchConfigured,
    readOnly,
    wrap,
    ariaLabel,
  };
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
      if (tr.selection || tr.docChanged) reportGroupCursor(group);
      const key = retainedKey(active.ref);
      let retained = states.get(key);
      if (active.ownsSource) {
        if (!retained) {
          retained = {
            state: view.state,
            generation: active.generation,
            baseline: view.state.doc,
            searchConfigured: false,
            readOnly: active.readOnly,
            wrap: active.wrap,
            ariaLabel: active.ariaLabel,
          };
          states.set(key, retained);
        } else {
          retained.state = view.state;
        }
        if (!skip && tr.docChanged && ownsWritableDocument(active)) {
          const equivalent = view.state.doc.eq(retained.baseline);
          peekDocument(active.ref)?.reportUserEdit(equivalent);
        }
      }
    },
  });

  view.dom.addEventListener("focusin", () => {
    const group = groups.get(groupId);
    if (group) reportGroupCursor(group);
  });
  view.dom.addEventListener("keydown", (event) => {
    const group = groups.get(groupId);
    const active = group?.active;
    if (!active) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (ownsWritableDocument(active)) active.onSave?.();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      void ensureSearch(group!);
    }
    if (event.key === "F3") {
      event.preventDefault();
      void ensureSearch(group!, true);
    }
    if (event.key === "F12") {
      event.preventDefault();
      void goToDefinition(group!);
    }
  });
  view.dom.addEventListener("mousedown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return;
    const group = groups.get(groupId);
    if (!group?.active) return;
    const offset = group.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (offset === null) return;
    event.preventDefault();
    void goToDefinition(group, offset);
  });
  view.dom.addEventListener("contextmenu", (event) => {
    const group = groups.get(groupId);
    if (!group?.active) return;
    const offset = group.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (offset === null) return;
    const detail = contextDetails(group, offset);
    if (!detail) return;
    event.preventDefault();
    dispatchEditorEvent("polyth:editor-context-menu", {
      ...detail,
      x: event.clientX,
      y: event.clientY,
    });
  });
  view.dom.addEventListener("compositionstart", () => {
    const active = groups.get(groupId)?.active;
    if (active && ownsWritableDocument(active)) peekDocument(active.ref)?.setComposing(true);
  });
  view.dom.addEventListener("compositionend", () => {
    const active = groups.get(groupId)?.active;
    if (active && ownsWritableDocument(active)) peekDocument(active.ref)?.setComposing(false);
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
  const existing = states.get(key);
  if (existing && existing.generation === generation) return existing;
  const text = handle?.getBuffer() ?? "";
  const fresh = freshRetained(text, readOnly, wrap, ariaLabel, generation);
  states.set(key, fresh);
  return fresh;
}

function applyBindingToView(group: EditorGroup, binding: EditorBinding): void {
  const retained = resolveRetained(binding.ref, binding.readOnly, binding.wrap, binding.ariaLabel);
  retained.readOnly = binding.readOnly;
  retained.wrap = binding.wrap;
  retained.ariaLabel = binding.ariaLabel;
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
      completionComp.reconfigure(completionExtensions(binding.readOnly, providerCompletionSources(binding.groupId, languageLabelOf(binding.path)))),
      intelligenceComp.reconfigure(intelligenceExtensions(binding.groupId, languageLabelOf(binding.path), binding.readOnly)),
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

function ownsWritableDocument(binding: EditorBinding): boolean {
  return binding.ownsSource && !binding.readOnly;
}

/** Persist the live view into retained state only when this binding owns it.
 *  Never recreate an evicted entry — close/delete must be able to drop state. */
function persistOwnedView(group: EditorGroup, binding: EditorBinding): void {
  if (!binding.ownsSource || !bindingMatches(group.active, binding)) return;
  const existing = states.get(retainedKey(binding.ref));
  if (!existing) return;
  existing.state = group.view.state;
}

function bindingConfigForReset(ref: ResourceRef): { readOnly: boolean; wrap: boolean; ariaLabel?: string } {
  const key = retainedKey(ref);
  for (const group of groups.values()) {
    if (group.active && resourceKey(group.active.ref) === key) {
      return { readOnly: group.active.readOnly, wrap: group.active.wrap, ariaLabel: group.active.ariaLabel };
    }
  }
  const existing = states.get(key);
  if (existing) {
    return { readOnly: existing.readOnly, wrap: existing.wrap, ariaLabel: existing.ariaLabel };
  }
  return { readOnly: false, wrap: true };
}

function resetRetainedState(ref: ResourceRef, text: string, generation: number): void {
  const key = retainedKey(ref);
  const config = bindingConfigForReset(ref);
  const fresh = freshRetained(
    text,
    config.readOnly,
    config.wrap,
    config.ariaLabel,
    generation,
    false,
  );
  states.set(key, fresh);
  for (const group of groups.values()) {
    if (group.active && resourceKey(group.active.ref) === key) {
      group.skip = true;
      group.view.setState(fresh.state);
      group.skip = false;
      group.searchConfigured = fresh.searchConfigured;
    }
  }
}

function advanceSavedBaseline(ref: ResourceRef, savedText: string): void {
  const key = retainedKey(ref);
  const retained = states.get(key);
  if (!retained) return;
  retained.baseline = Text.of(savedText.split("\n"));
}

export function releaseEditorState(ref: ResourceRef): void {
  const key = retainedKey(ref);
  states.delete(key);
  languageStatus.delete(key);
  latestChanges.delete(key);
  for (const group of groups.values()) {
    if (group.active && resourceKey(group.active.ref) === key) {
      group.active = null;
    }
  }
}

export function editorLanguageStatus(docKey: string): { label: string; fallback: boolean } {
  return languageStatus.get(docKey) ?? { label: tr("editor.plainText"), fallback: false };
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
  for (const group of groups.values()) {
    if (group.active) reportEditorCursor(group.active.ref, null);
    group.view.destroy();
  }
  groups.clear();
  states.clear();
  latestChanges.clear();
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

export function replaceEditorSelection(
  docKey: string,
  replacement: string,
  expectedText: string,
): boolean {
  const retained = states.get(docKey);
  if (!retained) return false;
  const main = retained.state.selection.main;
  if (main.empty) return false;
  const from = Math.min(main.from, main.to);
  const to = Math.max(main.from, main.to);
  const current = retained.state.sliceDoc(from, to);
  if (current !== expectedText) return false;
  for (const group of groups.values()) {
    if (!group.active || resourceKey(group.active.ref) !== docKey) continue;
    group.view.dispatch({ changes: { from, to, insert: replacement } });
    return true;
  }
  return false;
}

registerDocumentEditorBridge({
  onAuthoritativeReset(ref, text, generation) {
    resetRetainedState(ref, text, generation);
  },
  onSavedBaselineAdvanced(ref, text) {
    advanceSavedBaseline(ref, text);
  },
  onDocumentDeleted(ref) {
    releaseEditorState(ref);
  },
  onDocumentMoved(from, to) {
    const fromKey = retainedKey(from);
    const toKey = retainedKey(to);
    const retained = states.get(fromKey);
    if (retained) {
      states.delete(fromKey);
      states.set(toKey, retained);
    }
    languageStatus.delete(fromKey);
    languageStatus.delete(toKey);
    latestChanges.delete(fromKey);
    bumpLanguageStatus();
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
    () => tr("editor.plainText"),
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handle = peekDocument(props.resource);
    const generation = props.authoritativeGeneration ?? handle?.getSnapshot().authoritativeGeneration ?? 0;
    let releaseSource: (() => void) | null = null;
    let ownsSource = false;
    let readOnly = props.readOnly === true;
    const binding: EditorBinding = {
      groupId: props.groupId,
      ref: props.resource,
      path: props.path,
      readOnly,
      wrap: props.wrap !== false,
      ariaLabel: props.ariaLabel,
      onSave: props.onSave,
      generation,
      languageTicket: ++languageTicketCounter,
      ownsSource: false,
    };

    if (handle) {
      // The editor package is lazy-loaded, so a document can finish loading
      // before the editor bridge exists. Seed retained state from the document
      // buffer before attaching the EditorView as its source; otherwise the
      // shared group's initial empty state can replace the freshly loaded text.
      resolveRetained(props.resource, readOnly, binding.wrap, props.ariaLabel);
      const source = {
        getText: () => {
          const active = groups.get(props.groupId)?.active;
          if (!active || resourceKey(active.ref) !== docKey) {
            return states.get(docKey)?.state.doc.toString() ?? "";
          }
          const retained = states.get(docKey);
          return (groups.get(props.groupId)?.view.state ?? retained?.state)?.doc.toString() ?? "";
        },
      };
      const release = handle.attachSource(source);
      if (release === null) {
        ownsSource = false;
        readOnly = true;
      } else {
        ownsSource = true;
        releaseSource = release;
      }
    }
    binding.ownsSource = ownsSource;
    binding.readOnly = readOnly;
    bindingRef.current = binding;

    if (!props.visible) {
      const group = groups.get(props.groupId);
      if (group) persistOwnedView(group, binding);
      if (group && bindingMatches(group.active, binding)) {
        if (group.view.dom.parentElement === host) host.removeChild(group.view.dom);
        releaseSource?.();
        reportEditorCursor(binding.ref, null);
        group.active = null;
      }
      return () => {
        const g = groups.get(props.groupId);
        if (g) persistOwnedView(g, binding);
        releaseSource?.();
        if (g && bindingMatches(g.active, binding)) { reportEditorCursor(binding.ref, null); g.active = null; }
        if (g?.view.dom.parentElement === host) host.removeChild(g.view.dom);
      };
    }

    const group = getOrCreateGroup(props.groupId);
    group.active = binding;
    if (group.view.dom.parentElement !== host) {
      if (group.view.dom.parentElement) group.view.dom.parentElement.removeChild(group.view.dom);
      host.appendChild(group.view.dom);
    }

    applyBindingToView(group, binding);
    reportGroupCursor(group);
    // An owner that supplies change highlighting replaces the bare Git gutter.
    if (props.changes === undefined) void loadGitGutter(group, binding);
    else applyChangeMarks(group, docKey);
    if (ownsSource) {
      const existing = states.get(docKey);
      if (!existing) {
        states.set(docKey, {
          state: group.view.state,
          generation,
          baseline: group.view.state.doc,
          searchConfigured: false,
          readOnly: binding.readOnly,
          wrap: binding.wrap,
          ariaLabel: binding.ariaLabel,
        });
      }
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
        languageStatus.set(docKey, { label: language?.label ?? tr("editor.plainText"), fallback: false });
        bumpLanguageStatus();
        group.view.dispatch({
          effects: [languageComp.reconfigure(extension), syntaxComp.reconfigure(syntax)],
        });
      } catch {
        languageStatus.set(docKey, { label: `${language?.label ?? tr("editor.plainText")} · ${tr("editor.plainText")}`, fallback: true });
        bumpLanguageStatus();
        group.view.dispatch({
          effects: [languageComp.reconfigure([]), syntaxComp.reconfigure([])],
        });
      }
    })().catch(() => {
      languageStatus.set(docKey, { label: `${language?.label ?? tr("editor.plainText")} · ${tr("editor.plainText")}`, fallback: true });
      bumpLanguageStatus();
    });

    props.onReady?.();

    return () => {
      const g = groups.get(props.groupId);
      if (!g) return;
      persistOwnedView(g, binding);
      releaseSource?.();
      if (bindingMatches(g.active, binding)) { reportEditorCursor(binding.ref, null); g.active = null; }
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
    props.authoritativeGeneration,
    docKey,
  ]);

  // Change sets arrive independently of the binding: record the latest and
  // draw it when this document is the one shown.
  useLayoutEffect(() => {
    if (props.changes === undefined) {
      latestChanges.delete(docKey);
      return;
    }
    latestChanges.set(docKey, props.changes);
    const group = groups.get(props.groupId);
    if (group && props.visible) applyChangeMarks(group, docKey);
  }, [props.changes, props.groupId, props.visible, props.authoritativeGeneration, docKey]);

  return <div className="editor-code" ref={hostRef} data-language={languageLabel} />;
}

registerEditorSelection(editorSelection);
registerEditorReplace(replaceEditorSelection);
