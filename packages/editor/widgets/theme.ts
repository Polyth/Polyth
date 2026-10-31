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
  // Completion popup and tooltips. Readable without relying on a border:
  // raised fill, shared elevation shadow and accent wash for the selected row.
  ".cm-tooltip": {
    background: "var(--elevated)",
    color: "var(--text)",
    border: "1px solid var(--hair)",
    borderRadius: "var(--radius-control)",
    boxShadow: "var(--shadow-md)",
    fontFamily: "var(--ui-font-family)",
    fontSize: "var(--font-meta)",
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "var(--elevated)",
    borderBottomColor: "var(--elevated)",
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "var(--hair)",
    borderBottomColor: "var(--hair)",
  },
  // No overflow clip on the tooltip: CodeMirror places the completion info
  // panel outside the list's box. The list scroller rounds its own corners.
  ".cm-tooltip-autocomplete > ul": {
    borderRadius: "inherit",
    fontFamily: "var(--mono)",
    fontSize: "var(--font-code)",
    margin: "0",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-1)",
    minHeight: "24px",
    padding: "2px var(--space-2)",
    lineHeight: "1.4",
    color: "var(--text)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--accent-wash)",
    color: "var(--text)",
  },
  ".cm-completionIcon": {
    width: "1.1em",
    paddingRight: "0",
    color: "var(--text-dim)",
    textAlign: "center",
  },
  ".cm-completionLabel": { color: "var(--text)" },
  ".cm-completionDetail": {
    marginLeft: "auto",
    fontFamily: "var(--ui-font-family)",
    fontSize: "var(--font-meta)",
    fontStyle: "normal",
    color: "var(--muted)",
  },
  ".cm-completionMatchedText": {
    color: "var(--accent)",
    fontWeight: "650",
    textDecoration: "none",
  },
  ".cm-completionInfo": {
    background: "var(--panel)",
    color: "var(--text)",
    border: "1px solid var(--hair)",
    borderRadius: "var(--radius-control)",
    boxShadow: "var(--shadow-md)",
    padding: "var(--space-2)",
    maxWidth: "32ch",
  },
  // Coarse pointers get a comfortably tappable row.
  "@media (pointer: coarse)": {
    ".cm-tooltip-autocomplete > ul > li": {
      minHeight: "32px",
      padding: "var(--space-1) var(--space-2)",
    },
  },
  // Hover details from an `editor.intelligence` provider. The signature keeps
  // the code voice; documentation is plain text (the provider never ships
  // markup) and gets the UI voice with a capped measure and its own scroll.
  ".cm-tooltip-hover": {
    padding: "var(--space-2) var(--space-3)",
    maxWidth: "60ch",
  },
  ".editor-intelligence-hover": {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
    minWidth: "0",
  },
  ".editor-intelligence-hover-display": {
    fontFamily: "var(--mono)",
    fontSize: "var(--font-code)",
    color: "var(--text)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ".editor-intelligence-hover-documentation": {
    fontFamily: "var(--ui-font-family)",
    fontSize: "var(--font-meta)",
    lineHeight: "var(--font-meta-lh, 1.45)",
    color: "var(--text-dim)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: "18em",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  // Problem list. Severity is carried by the Message text and the lint gutter
  // marker (an SVG background, not a border), so borderless mode — which makes
  // every border transparent — loses no meaning. The left stripe is a quiet
  // extra accent in the default appearance only. CodeMirror's squiggle
  // background images (`.cm-lintRange-*`) are left untouched: they already
  // read as red/amber/grey and recolouring them would need literal hex inside
  // a data-URI SVG, which cannot resolve theme tokens.
  ".cm-panel.cm-panel-lint ul": { maxHeight: "30vh" },
  ".cm-diagnostic": {
    fontFamily: "var(--ui-font-family)",
    fontSize: "var(--font-meta)",
    color: "var(--text)",
  },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--red)", color: "var(--text)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--amber)" },
  ".cm-diagnostic-info": { borderLeft: "3px solid var(--accent)" },
  ".cm-diagnosticSource": { color: "var(--muted)", opacity: "1" },
  ".cm-lintRange-active": { backgroundColor: "var(--surface-overlay-strong)" },
  ".cm-gutter-lint": { width: "1.4em" },
  ".cm-gutter-lint .cm-gutterElement": { padding: "2px" },
  ".cm-lint-marker": { opacity: "0.9" },
});
