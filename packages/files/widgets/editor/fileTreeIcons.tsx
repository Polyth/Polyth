// UX-FILES-TIMELINE-03 finding 1: file-type aware glyphs for the Project
// Files tree. One pure name→family mapping plus tiny inline SVGs so the tree
// (EditorView), search results, and tests share a single source of truth.
// Families tint via `data-ft` rules in styles.css — no per-type components.
import type { JSX } from "react";

/** Broad visual family for a file name (drives the icon shape and tint). */
export type FileTypeKey =
  | "code" | "markup" | "doc" | "data" | "style" | "image" | "shell" | "config" | "file";

const EXT_TYPES: Record<string, FileTypeKey> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", go: "code", rs: "code", rb: "code", java: "code", c: "code",
  h: "code", cc: "code", cpp: "code", cs: "code", php: "code", swift: "code", kt: "code",
  html: "markup", htm: "markup", xhtml: "markup", xml: "markup", svg: "markup",
  vue: "markup", svelte: "markup",
  md: "doc", markdown: "doc", txt: "doc", rst: "doc", adoc: "doc",
  json: "data", yaml: "data", yml: "data", toml: "data", csv: "data",
  css: "style", scss: "style", sass: "style", less: "style",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  ico: "image", bmp: "image", avif: "image",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell", bat: "shell",
  lock: "config", env: "config", ini: "config", cfg: "config", conf: "config",
};

/** Pure: map a file NAME (not path) to its visual family. Dotfiles read as
 *  configuration; unknown or missing extensions fall back to "file". */
export function fileTypeKeyOf(name: string): FileTypeKey {
  const base = name.toLowerCase();
  if (base.startsWith(".")) return "config";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "file";
  return EXT_TYPES[base.slice(dot + 1)] ?? "file";
}

const g = {
  className: "file-tree-glyph", viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  "aria-hidden": true as const, focusable: false,
};

/** Disclosure triangle for directory rows; CSS rotates it when open. */
export function ChevronGlyph(): JSX.Element {
  return <svg {...g} className="file-tree-glyph file-tree-chevron"><path d="m9 18 6-6-6-6" /></svg>;
}

export function FolderGlyph(): JSX.Element {
  return (
    <svg {...g}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

const FILE_OUTLINE = <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />;
const FILE_CORNER = <path d="M13 2v7h7" />;

/** File glyph per family: a shared doc outline for text-ish files and
 *  distinct shapes for code, images, data, styles, shells, and configs. */
export function FileTypeGlyph({ type }: { type: FileTypeKey }): JSX.Element {
  switch (type) {
    case "code":
    case "markup":
      return <svg {...g}><path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" /></svg>;
    case "image":
      return (
        <svg {...g}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      );
    case "data":
      return (
        <svg {...g}>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14a9 3 0 0 0 18 0V5" />
          <path d="M3 12a9 3 0 0 0 18 0" />
        </svg>
      );
    case "style":
      return <svg {...g}><path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0Z" /></svg>;
    case "shell":
      return <svg {...g}><path d="m4 17 6-5-6-5" /><path d="M12 19h8" /></svg>;
    case "config":
      return (
        <svg {...g}>
          <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
          <path d="M1 14h6M9 8h6M17 16h6" />
        </svg>
      );
    case "doc":
      return <svg {...g}>{FILE_OUTLINE}{FILE_CORNER}<path d="M9 13h6M9 17h4" /></svg>;
    default:
      return <svg {...g}>{FILE_OUTLINE}{FILE_CORNER}</svg>;
  }
}
