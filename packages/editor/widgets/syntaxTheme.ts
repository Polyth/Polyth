import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Loaded with a grammar — must not be imported from the plain-text core. */
export const editorHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--syntax-kw)" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: "var(--syntax-str)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: "var(--syntax-cmt)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: "var(--syntax-num)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.operator], color: "var(--syntax-punc)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--blue)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--purple)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--red)" },
  { tag: t.heading, fontWeight: "600" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--red)" },
]));
