// Display helpers + markdown export (DOM-free).
import type { RenderModel } from "./reduce.ts";

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtCost(c: number): string {
  return `$${c.toFixed(4)}`;
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