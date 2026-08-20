// URL policy for rendered Markdown (WP4). Pure and DOM-free.
// Links: http(s) + mailto + in-app #anchors. Images: http(s) or project files
// served through /api/files/raw (path revalidated server-side). Everything
// else — javascript:, data:, file:, vbscript:, protocol-relative — is dropped.

const SCHEME_RE = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function sanitizeLinkHref(href: string): string | null {
  const h = href.trim();
  if (!h) return null;
  if (h.startsWith("#")) return h;
  const m = SCHEME_RE.exec(h);
  if (!m) {
    // relative/anchor-less: allow plain relative paths (rendered as text links
    // elsewhere) but block protocol-relative //host
    if (h.startsWith("//")) return null;
    return h;
  }
  const scheme = m[1]!.toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? h : null;
}

export interface ImageSrcOptions {
  projectId?: string;
}

/** Resolve an image source: https stays; project-relative paths are routed
 *  through the raw-file endpoint; traversal and unsafe schemes are rejected. */
export function sanitizeImageSrc(src: string, opts: ImageSrcOptions = {}): string | null {
  const s = src.trim();
  if (!s) return null;
  if (s.startsWith("//")) return null;
  const m = SCHEME_RE.exec(s);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    return scheme === "http" || scheme === "https" ? s : null;
  }
  // project-relative path
  if (!opts.projectId) return null;
  const clean = s.replace(/^\.\//, "");
  if (clean.startsWith("/") || clean.split(/[/\\]/).includes("..")) return null;
  return `/api/files/raw?projectId=${encodeURIComponent(opts.projectId)}&path=${encodeURIComponent(clean)}`;
}
