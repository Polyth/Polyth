import { EditorView } from "@codemirror/view";

const selection = "rgba(var(--accent-rgb), 0.28)";

/** Core visual theme. Uses @codemirror/view only — syntax highlighting
 *  lives in syntaxTheme.ts and loads with language support. */
export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--sunken)",
    fontSize: "var(--font-code)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.55",
    overscrollBehavior: "contain",
  },
  ".cm-content": {
    padding: "var(--space-1) 0",
    caretColor: "var(--text)",
    minHeight: "100%",
  },
  ".cm-line": { padding: "0 var(--space-3) 0 var(--space-2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--text)", marginLeft: "-1px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: selection,
  },
  ".cm-activeLine": { backgroundColor: "var(--surface-overlay-hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-dim)" },
  ".cm-gutters": {
    backgroundColor: "color-mix(in srgb, var(--sunken) 92%, var(--panel))",
    color: "var(--faint)",
    border: "0",
    borderRight: "1px solid var(--hair)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 var(--space-2) 0 var(--space-3)",
    minWidth: "3.25ch",
    textAlign: "right",
  },
  ".cm-panels": {
    backgroundColor: "var(--panel)",
    color: "var(--text)",
    fontFamily: "var(--ui-font-family)",
    fontSize: "var(--font-meta)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--surface-divider)" },
  ".cm-panel.cm-search": { padding: "var(--space-1) var(--space-2)" },
  ".cm-textfield": {
    background: "var(--input-bg)",
    color: "var(--text)",
    border: "1px solid var(--control-border)",
    borderRadius: "var(--radius-control)",
    padding: "2px var(--space-2)",
    fontSize: "max(16px, var(--font-input))",
  },
  ".cm-button": {
    backgroundImage: "none",
    background: "var(--elevated)",
    color: "var(--text)",
    border: "1px solid var(--control-border)",
    borderRadius: "var(--radius-control)",
    padding: "2px var(--space-2)",
  },
});
