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

/** Compact "time ago" for session rows: 45s, 3m, 6h, 2d. */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Platform modifier key label: ⌘ on Apple platforms, Ctrl elsewhere. */
export function modKey(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

export const MOD = modKey(typeof navigator === "undefined" ? "" : navigator.platform ?? "");

/** Auto-title placeholder sessions from their first user message (UX-43). */
export function deriveSessionTitle(title: string, firstUserText?: string): string {
  const t = title.trim();
  const isPlaceholder = t === "" || /^new session$/i.test(t) || /^\(untitled/.test(t);
  if (!isPlaceholder || !firstUserText) return t || "(untitled)";
  const line = firstUserText.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!line) return t || "(untitled)";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
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
    } else {
      lines.push(`### Tool: ${m.tool} — ${m.status}`);
      lines.push(`\nInput:\n\`\`\`json\n${JSON.stringify(m.input, null, 2)}\n\`\`\``);
      if (m.output !== undefined) lines.push(`\nOutput:\n\n${m.output}`);
      if (m.error !== undefined) lines.push(`\nError:\n\n${m.error}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}