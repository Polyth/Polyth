// Display helpers + markdown export (DOM-free).
import type { RenderModel } from "./reduce.ts";
import { formatDate, formatNumber, tr } from "./i18n/index.ts";
import { normalizeQuestions, questionsToMarkdown, type AnswerMap } from "./questionSerializers.ts";

export { formatDate };

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${formatNumber(ms)}ms`;
  return `${formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}s`;
}

/** Wall-clock span for "Worked for …" labels: 46s, 3m 1s, 1h 4m. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return tr("format.durationSeconds", { value: formatNumber(s) });
  if (s < 3600) {
    return tr("format.durationMinutes", {
      minutes: formatNumber(Math.floor(s / 60)),
      seconds: formatNumber(s % 60),
    });
  }
  return tr("format.durationHours", {
    hours: formatNumber(Math.floor(s / 3600)),
    minutes: formatNumber(Math.floor((s % 3600) / 60)),
  });
}

/** Compact navigator clock: mm:ss under an hour, then h:mm without seconds. */
export function fmtSessionElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Largest first. */
const TOKEN_UNITS = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
] as const;

/** One decimal turns anything from 999.95 up into "1,000.0", which is "1.0" of the next unit. */
const TOKEN_UNIT_ROLLOVER = 999.95;

/** Compact token count with one decimal: 999, 1.0k, 12.3M, 4.5B. */
export function fmtTokens(n: number): string {
  let tier = TOKEN_UNITS.findIndex(([size]) => n >= size);
  if (tier < 0) return formatNumber(n);
  if (tier > 0 && n / TOKEN_UNITS[tier]![0] >= TOKEN_UNIT_ROLLOVER) tier -= 1;
  const [size, suffix] = TOKEN_UNITS[tier]!;
  return `${formatNumber(n / size, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${suffix}`;
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

/** Auto-title placeholder sessions from their first user message. */
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

/** The wide session rail can carry more prompt context than compact session
 *  lists. Keep deliberate/native titles intact, but expand Polyth's clipped
 *  prompt fallback when the original first message is already cached. */
export function displayWideSessionTitle(
  title: string,
  titleSource: "manual" | "native" | "generated" | "polyth" | "placeholder" | undefined,
  sessionId?: string,
  firstUserText?: string,
  maxPromptLength = 72,
): string {
  if (firstUserText !== undefined && firstUserText.trim() !== "") {
    const compactPromptTitle = titleFromPrompt(firstUserText);
    const promptDerived = titleSource === "polyth"
      || titleSource === "placeholder"
      || isPlaceholderTitle(title, sessionId)
      || (titleSource === undefined && title.trim() === compactPromptTitle);
    if (promptDerived) return titleFromPrompt(firstUserText, maxPromptLength);
  }
  return displaySessionTitle(title, sessionId, firstUserText);
}

const startOfLocalDay = (value: Date): number =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

/** A chat time divider in the Messages manner: "Today 3:19 PM",
 *  "Yesterday 9:02 AM", "Monday 3:19 PM" within the week, otherwise the date
 *  (with the year when it is not this one). `day` is the emphasized part. */
export function chatDividerParts(ts: number, now = Date.now(), locale?: string): { day: string; time: string } {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const capitalized = (text: string) => text ? `${text.charAt(0).toLocaleUpperCase(locale)}${text.slice(1)}` : text;
  // Rounded so a daylight-saving day (23 or 25 hours) still counts as one.
  const days = Math.round((startOfLocalDay(new Date(now)) - startOfLocalDay(date)) / 86_400_000);
  if (days <= 1) {
    return { day: capitalized(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-Math.max(0, days), "day")), time };
  }
  if (days < 7) return { day: capitalized(date.toLocaleDateString(locale, { weekday: "long" })), time };
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return {
    day: capitalized(date.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })),
    time,
  };
}

const EMOJI_GRAPHEME = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️\u{E0020}-\u{E007F}]+|[#*0-9]️?⃣)$/u;

/** How many emoji a message is made of when it is nothing else (1–3), so it
 *  can be shown large without a bubble; 0 for anything else. */
export function emojiOnlyCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 48 || typeof Intl.Segmenter !== "function") return 0;
  let count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!EMOJI_GRAPHEME.test(segment) || ++count > 3) return 0;
  }
  return count;
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
    } else if (m.kind === "notice") {
      lines.push(m.topic === "isolation-merged"
        ? `Merged into ${m.branch ?? ""} · ${m.commit ?? ""}`
        : m.topic === "isolation-started"
          ? `Moved to an isolated workspace from ${m.branch ?? ""}`
          : "Isolated workspace discarded");
    } else if (m.kind === "question") {
      lines.push(`### Question\n\n${questionsToMarkdown(normalizeQuestions(m.questions), (m.answers ?? {}) as AnswerMap)}`);
    } else if (m.kind === "person-message") {
      lines.push(`## ${m.author?.name || "Person"}\n\n${m.text}`);
    } else if (m.kind === "conversation-started") {
      lines.push(`## ${m.startedBy?.name || "Person"} started a session: ${m.title}`);
    } else {
      lines.push(`### Task ${m.action}: ${m.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
