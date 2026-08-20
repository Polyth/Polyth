// Display helpers + markdown export (DOM-free).
import type { RenderModel } from "./reduce.ts";

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wall-clock span for "Worked for …" labels: 46s, 3m 1s, 1h 4m. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtCost(c: number): string {
  return `$${c.toFixed(4)}`;
}

/** Platform modifier key label: ⌘ on Apple platforms, Ctrl elsewhere. */
export function modKey(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

export const MOD = modKey(typeof navigator === "undefined" ? "" : navigator.platform ?? "");

/** Full title used by hover/focus affordances before visual truncation. */
export function fullSessionTitle(title: string, firstUserText?: string): string {
  const t = title.trim();
  const isPlaceholder = t === "" || /^new session$/i.test(t) || /^\(untitled/.test(t);
  if (!isPlaceholder || !firstUserText) return t || "(untitled)";
  const line = firstUserText.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line || t || "(untitled)";
}

/** Auto-title placeholder sessions from their first user message (UX-43). */
export function deriveSessionTitle(title: string, firstUserText?: string): string {
  const full = fullSessionTitle(title, firstUserText);
  const t = title.trim();
  const isPlaceholder = t === "" || /^new session$/i.test(t) || /^\(untitled/.test(t);
  return isPlaceholder && full.length > 48 ? `${full.slice(0, 47)}…` : full;
}

export function providerColor(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("anthropic") || p.includes("claude")) return "#f49b5b";
  if (p.includes("openai") || p.includes("gpt")) return "#8bcf6b";
  if (p.includes("google") || p.includes("gemini")) return "#82bff4";
  if (p.includes("xai") || p.includes("grok")) return "#c4a7ee";
  if (p.includes("mistral")) return "#82bff4";
  if (p.includes("meta") || p.includes("llama")) return "#e4bb62";
  return "#a19e96";
}

// ---- session title display --------------------------------------------------

const PLACEHOLDER_TITLES = new Set(["", "new session", "untitled session", "untitled", "(untitled)", "(untitled session)"]);

export function isPlaceholderTitle(title: string, sessionId?: string): boolean {
  const t = title.trim();
  if (PLACEHOLDER_TITLES.has(t.toLowerCase())) return true;
  if (sessionId !== undefined && t === sessionId) return true;
  if (t.startsWith("ses_")) return true;
  if (/^[0-9a-f-]{8,}$/i.test(t)) return true;
  return false;
}

export function titleFromPrompt(text: string, max = 48): string {
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}

export function displaySessionTitle(title: string, sessionId?: string, firstUserText?: string): string {
  if (!isPlaceholderTitle(title, sessionId)) return title.trim();
  if (firstUserText !== undefined && firstUserText.trim() !== "") return titleFromPrompt(firstUserText);
  return "New session";
}

/** Compact "time ago" for session rows: 45s, 3m, 6h, 2d. */
export function ago(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function modelBadge(model?: { providerID: string; modelID: string } | string): { label: string; color: string } {
  if (!model) return { label: "default", color: "#a19e96" };
  if (typeof model === "string") {
    const slash = model.lastIndexOf("/");
    const prov = slash >= 0 ? model.slice(0, slash) : "";
    const id = slash >= 0 ? model.slice(slash + 1) : model;
    return { label: id || model, color: providerColor(prov || model) };
  }
  return { label: model.modelID, color: providerColor(model.providerID) };
}

// Export a session's render model as a downloadable .md transcript.
export function modelToMarkdown(model: RenderModel): string {
  const lines: string[] = [];
  for (const m of model.messages) {
    if (m.kind === "user") {
      lines.push(`## User\n\n${m.text}`);
    } else if (m.kind === "assistant") {
      lines.push("## Assistant");
      if (m.reasoning) lines.push(`\n<details>\n<summary>Reasoning</summary>\n\n${m.reasoning}\n</details>`);
      lines.push(`\n${m.text}`);
    } else if (m.kind === "tool") {
      lines.push(`### Tool: ${m.tool} — ${m.status}`);
      lines.push(`\nInput:\n\`\`\`json\n${JSON.stringify(m.input, null, 2)}\n\`\`\``);
      if (m.output !== undefined) lines.push(`\nOutput:\n\n${m.output}`);
      if (m.error !== undefined) lines.push(`\nError:\n\n${m.error}`);
    } else {
      lines.push(`### Task ${m.action}: ${m.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}