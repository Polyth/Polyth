// Compatibility face: the Markdown implementation lives in markdown/.
// Chat, multirun, fusion and file preview all share this sanitized renderer.
// Packages that render fence content reuse the same URL policy.
export { renderMarkdown, MarkdownDoc } from "./markdown/render.tsx";
export { sanitizeImageSrc, sanitizeLinkHref } from "./markdown/sanitize.ts";
