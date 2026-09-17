// File-tree glyphs for the Project Files navigator. One name→family mapping
// plus compact filled SVGs (VS Code explorer density) so the tree, search
// results, and tests share a single source of truth. Families tint via
// `data-ft` rules in styles.css — no per-type components.
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
  className: "file-tree-glyph",
  viewBox: "0 0 16 16",
  fill: "currentColor",
  "aria-hidden": true as const,
  focusable: false,
};

/** Disclosure triangle for directory rows; CSS rotates it when open. */
export function ChevronGlyph(): JSX.Element {
  return (
    <svg {...g} className="file-tree-glyph file-tree-chevron">
      <path d="M6 3.2 11.2 8 6 12.8z" />
    </svg>
  );
}

export function FolderGlyph({ open = false }: { open?: boolean }): JSX.Element {
  if (open) {
    return (
      <svg {...g}>
        <path d="M1.5 3.1h4.35L7.1 4.5h6.9l.5.5V6H1.6L1.5 3.1z" />
        <path d="M1.4 6.4h13.35L13.15 13.5H2.65z" />
      </svg>
    );
  }
  return (
    <svg {...g}>
      <path d="M1.5 2.4h4.4L7.1 3.9h7.4l.5.5v8.7l-.5.5h-13l-.5-.5V2.9l.5-.5z" />
    </svg>
  );
}

function FilePage(): JSX.Element {
  return (
    <svg {...g}>
      <path d="M3.2 1.4h5.55L12.8 5.45V14.6H3.2z" />
    </svg>
  );
}

/** File glyph per family: a shared filled page for text-ish files and
 *  distinct silhouettes for code, images, data, styles, shells, and configs. */
export function FileTypeGlyph({ type }: { type: FileTypeKey }): JSX.Element {
  switch (type) {
    case "code":
    case "markup":
      return (
        <svg {...g}>
          <path d="M5.7 3.4 2.15 8 5.7 12.6l-.95.75L1.05 8 4.75 2.65zM10.3 3.4 13.85 8 10.3 12.6l.95.75L14.95 8 11.25 2.65z" />
        </svg>
      );
    case "image":
      return (
        <svg {...g}>
          <path
            fillRule="evenodd"
            d="M2.2 2.2h11.6v11.6H2.2zm2.35 2.15a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM3.4 12.55l2.35-2.1 1.7 1.45 3.15-3.7 3 3.7v.65z"
          />
        </svg>
      );
    case "data":
      return (
        <svg {...g}>
          <path d="M8 1.4c3.4 0 6.2 1.15 6.2 2.55v8.1C14.2 13.45 11.4 14.6 8 14.6S1.8 13.45 1.8 12.05v-8.1C1.8 2.55 4.6 1.4 8 1.4zm0 1.35c-2.7 0-4.85.75-4.85 1.2S5.3 5.15 8 5.15s4.85-.75 4.85-1.2S10.7 2.75 8 2.75z" />
        </svg>
      );
    case "style":
      return (
        <svg {...g}>
          <path d="M8 1.5 3.4 6.4a6.5 6.5 0 1 0 9.2 0z" />
        </svg>
      );
    case "shell":
      return (
        <svg {...g}>
          <path d="M2.4 3.6 7.1 8 2.4 12.4l1.05.95L9.15 8 3.45 2.65zM8.6 12.15h5.2v1.45H8.6z" />
        </svg>
      );
    case "config":
      return (
        <svg {...g}>
          <path d="M3.1 1.5h1.7v5.1H3.1zm0 7.9h1.7v5.1H3.1zm4.05-4.4h1.7v9.5H7.15zm0-3.5h1.7v2.1H7.15zm4.05 6.2h1.7v6.4h-1.7zm0-8.6h1.7v7.2h-1.7z" />
        </svg>
      );
    case "doc":
      return <FilePage />;
    default:
      return <FilePage />;
  }
}
