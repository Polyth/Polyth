import { useLayoutEffect, useRef, type ReactElement } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { ResourceRef } from "@polyth/web-sdk";
import { peekDocument } from "../../../apps/web/src/resources/documents.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { registerEditorSelection, type EditorSurfaceProps } from "../../../apps/web/src/resources/views.ts";
import { editorTheme } from "./theme.ts";
import { detectIndentUnit, languageOf, lineRangeFromOffsets, PLAIN_TEXT_LABEL } from "./languages.ts";

const GROUP_ID = "files";
const SHELL_KEYS = new Set(["Mod-i"]);

interface Group {
  view: EditorView;
  skip: boolean;
}

const groups = new Map<string, Group>();
const states = new Map<string, EditorState>();
const languageStatus = new Map<string, { label: string; fallback: boolean }>();

const wrapComp = new Compartment();
const readOnlyComp = new Compartment();
const languageComp = new Compartment();
const searchComp = new Compartment();
const syntaxComp = new Compartment();
const phrasesComp = new Compartment();
const labelComp = new Compartment();

let searchModule: Promise<typeof import("@codemirror/search")> | null = null;

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

function parseDocKey(docKey: string): ResourceRef | null {
  const parts = docKey.split(":");
  if (parts.length < 4) return null;
  const [scheme, projectId, scope, ...locator] = parts;
  if (!scheme || !projectId || !scope) return null;
  return { scheme, projectId, sessionId: scope === "project" ? null : scope, locator: locator.join(":") };
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

async function ensureSearch(view: EditorView): Promise<void> {
  searchModule ??= import("@codemirror/search");
  const search = await searchModule;
  view.dispatch({
    effects: searchComp.reconfigure([
      search.search({ top: true }),
      keymap.of(search.searchKeymap.filter((binding) => ["Mod-f", "F3", "Escape"].includes(binding.key ?? ""))),
    ]),
  });
  search.openSearchPanel(view);
}

export function editorLanguageStatus(docKey: string): { label: string; fallback: boolean } {
  return languageStatus.get(docKey) ?? { label: PLAIN_TEXT_LABEL, fallback: false };
}

export function editorViewCount(): number {
  return [...groups.values()].filter((group) => group.view.dom.isConnected).length;
}

export function retainedStateCount(): number {
  return states.size;
}

export function resetEditorRuntimeForTest(): void {
  for (const group of groups.values()) group.view.destroy();
  groups.clear();
  states.clear();
  languageStatus.clear();
}

export function editorSelection(docKey: string): { text: string; startLine: number; endLine: number } | null {
  const state = states.get(docKey) ?? groups.get(GROUP_ID)?.view.state;
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

export default function EditorRuntime(props: EditorSurfaceProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !props.visible) return;
    const ref = parseDocKey(props.docKey);
    const handle = ref ? peekDocument(ref) : null;
    const initial = handle?.getBuffer() ?? "";

    let group = groups.get(GROUP_ID);
    if (!group) {
      const view = new EditorView({
        state: createState(initial, props.readOnly === true, props.wrap !== false, props.ariaLabel),
        dispatch: (tr, view) => {
          const skip = groups.get(GROUP_ID)?.skip === true;
          view.update([tr]);
          const current = propsRef.current;
          states.set(current.docKey, view.state);
          if (!skip && tr.docChanged) {
            const docRef = parseDocKey(current.docKey);
            if (docRef) peekDocument(docRef)?.markUserEdit();
          }
        },
      });
      view.dom.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          propsRef.current.onSave?.();
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          void ensureSearch(view);
        }
        if (event.key === "F3") {
          event.preventDefault();
          void ensureSearch(view);
        }
      });
      view.dom.addEventListener("compositionstart", () => {
        const docRef = parseDocKey(propsRef.current.docKey);
        if (docRef) peekDocument(docRef)?.setComposing(true);
      });
      view.dom.addEventListener("compositionend", () => {
        const docRef = parseDocKey(propsRef.current.docKey);
        if (docRef) peekDocument(docRef)?.setComposing(false);
      });
      group = { view, skip: false };
      groups.set(GROUP_ID, group);
    }

    host.appendChild(group.view.dom);
    const incoming = states.get(props.docKey)
      ?? createState(initial, props.readOnly === true, props.wrap !== false, props.ariaLabel);
    if (group.view.state !== incoming) {
      group.skip = true;
      group.view.setState(incoming);
      group.skip = false;
    }
    states.set(props.docKey, group.view.state);
    group.view.dispatch({
      effects: [
        wrapComp.reconfigure(props.wrap !== false ? EditorView.lineWrapping : []),
        readOnlyComp.reconfigure([
          EditorState.readOnly.of(props.readOnly === true),
          EditorView.editable.of(props.readOnly !== true),
        ]),
        phrasesComp.reconfigure(phrases()),
        labelComp.reconfigure(EditorView.contentAttributes.of(props.ariaLabel ? { "aria-label": props.ariaLabel } : {})),
      ],
    });
    handle?.attachSource({
      getText: () => (states.get(props.docKey) ?? group!.view.state).doc.toString(),
      resetAuthoritative: (text) => {
        const next = createState(text, propsRef.current.readOnly === true, propsRef.current.wrap !== false, propsRef.current.ariaLabel);
        states.set(props.docKey, next);
        const active = groups.get(GROUP_ID);
        if (!active) return;
        active.skip = true;
        active.view.setState(next);
        active.skip = false;
      },
    });
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
    const ticket = props.docKey;
    void (language ? language.load() : Promise.resolve([] as const)).then(async (extension) => {
      const active = groups.get(GROUP_ID);
      if (!active || propsRef.current.docKey !== ticket) return;
      try {
        const syntax = language ? (await import("./syntaxTheme.ts")).editorHighlight : [];
        languageStatus.set(ticket, { label: language?.label ?? PLAIN_TEXT_LABEL, fallback: false });
        active.view.dispatch({
          effects: [languageComp.reconfigure(extension), syntaxComp.reconfigure(syntax)],
        });
      } catch {
        languageStatus.set(ticket, { label: `${language?.label ?? PLAIN_TEXT_LABEL} · ${PLAIN_TEXT_LABEL}`, fallback: true });
        active.view.dispatch({
          effects: [languageComp.reconfigure([]), syntaxComp.reconfigure([])],
        });
      }
    }).catch(() => {
      languageStatus.set(ticket, { label: `${language?.label ?? PLAIN_TEXT_LABEL} · ${PLAIN_TEXT_LABEL}`, fallback: true });
    });
    props.onReady?.();
    return () => {
      states.set(props.docKey, group!.view.state);
      handle?.detachSource();
    };
  }, [props.docKey, props.visible, props.path, props.readOnly, props.wrap, props.ariaLabel, props.onReady, props.reveal, props.onRevealConsumed]);

  return <div className="editor-code" ref={hostRef} data-language={languageStatus.get(props.docKey)?.label ?? PLAIN_TEXT_LABEL} />;
}

registerEditorSelection(editorSelection);
