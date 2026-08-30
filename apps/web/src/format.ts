// Display helpers + markdown export (DOM-free).
import type { RenderModel } from "./reduce.ts";
import { formatNumber, tr } from "./i18n/index.ts";

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${formatNumber(ms)}ms`;
  return `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}s`;
}

/** Wall-clock span for "Worked for …" labels: 46s, 3m 1s, 1h 4m. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${formatNumber(s)}s`;
  if (s < 3600) return `${formatNumber(Math.floor(s / 60))}m ${formatNumber(s % 60)}s`;
  return `${formatNumber(Math.floor(s / 3600))}h ${formatNumber(Math.floor((s % 3600) / 60))}m`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${formatNumber(n / 1_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
  if (n >= 1_000) return `${formatNumber(n / 1_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  return formatNumber(n);
}

export function fmtCost(c: number): string {
  return formatNumber(c, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

/** Platform modifier key label: ⌘ on Apple platforms, Ctrl elsewhere. */
export function modKey(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

export const MOD = modKey(typeof navigator === "undefined" ? "" : navigator.platform ?? "");

/** Full title used by hover/focus affordances before visual truncation. */
export function fullSessionTitle(title: string, firstUserText?: string): string {
  const t = title.trim();
  const isPlaceholder = isPlaceholderTitle(t);
  if (!isPlaceholder || !firstUserText) return t || "(untitled)";
  const line = firstUserText.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line || t || "(untitled)";
}

/** Auto-title placeholder sessions from their first user message (UX-43). */
export function deriveSessionTitle(title: string, firstUserText?: string): string {
  const full = fullSessionTitle(title, firstUserText);
  const t = title.trim();
  const isPlaceholder = isPlaceholderTitle(t);
  return isPlaceholder && full.length > 48 ? `${full.slice(0, 47)}…` : full;
}

export function providerColor(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("anthropic") || p.includes("claude")) return "var(--accent)";
  if (p.includes("openai") || p.includes("gpt")) return "var(--green)";
  if (p.includes("google") || p.includes("gemini")) return "var(--blue)";
  if (p.includes("xai") || p.includes("grok")) return "var(--purple)";
  if (p.includes("mistral")) return "var(--blue)";
  if (p.includes("meta") || p.includes("llama")) return "var(--amber)";
  return "var(--muted)";
}

// ---- session title display --------------------------------------------------

const PLACEHOLDER_TITLES = new Set([
  "",
  "new session",
  "untitled",
  "(untitled)",
  "untitled session",
  "(untitled session)",
  tr("format.newSession").toLowerCase(),
  tr("format.untitledSession").toLowerCase(),
  tr("format.untitled").toLowerCase(),
  tr("format.untitled2").toLowerCase(),
  tr("format.untitledSession2").toLowerCase(),
]);

export function isPlaceholderTitle(title: string, sessionId?: string): boolean {
  const t = title.trim();
  if (PLACEHOLDER_TITLES.has(t.toLowerCase())) return true;
  if (/^new session - \d{4}-\d{2}-\d{2}t/i.test(t)) return true;
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
  return tr("format.newSession");
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
  if (!model) return { label: tr("format.default"), color: "var(--muted)" };
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
    } else if (m.kind === "github-conflict") {
      lines.push(`### Fixing merge conflicts for pull request #${m.prNumber}`);
      lines.push(`\n${m.title}\n\n\`${m.baseRefName} ← ${m.headRefName}\`\n\n${m.url}`);
    } else {
      lines.push(`### Task ${m.action}: ${m.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}