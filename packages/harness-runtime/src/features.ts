import type { AttachmentRef, TokenUsage } from "@polyth/contracts";
import { formatBrowserContextForModel } from "@polyth/contracts";

const PLACEHOLDER_TITLES = new Set([
  "",
  "new session",
  "untitled",
  "(untitled)",
  "untitled session",
  "(untitled session)",
]);

/** Derive a short session title from the first line of user text. */
export const titleFromPrompt = (text: string, max = 48): string => {
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
};

/** English/ISO/uuid/ses_ placeholder detection (shell i18n extras stay in apps/web). */
export const isPlaceholderTitle = (title: string, sessionId?: string): boolean => {
  const t = title.trim();
  if (PLACEHOLDER_TITLES.has(t.toLowerCase())) return true;
  if (/^new session - \d{4}-\d{2}-\d{2}t/i.test(t)) return true;
  if (sessionId !== undefined && t === sessionId) return true;
  if (t.startsWith("ses_")) return true;
  if (/^[0-9a-f-]{8,}$/i.test(t)) return true;
  return false;
};

const floorUsage = (value: number): number => Math.max(0, value);

/** Delta between cumulative usage snapshots; floors at 0. */
export const deltaTokenUsage = (
  previousCumulative: TokenUsage | undefined,
  currentCumulative: TokenUsage,
): TokenUsage => ({
  input: floorUsage(currentCumulative.input - (previousCumulative?.input ?? 0)),
  output: floorUsage(currentCumulative.output - (previousCumulative?.output ?? 0)),
  ...(currentCumulative.reasoning !== undefined
    ? { reasoning: floorUsage(currentCumulative.reasoning - (previousCumulative?.reasoning ?? 0)) }
    : {}),
  ...(currentCumulative.cacheRead !== undefined
    ? { cacheRead: floorUsage(currentCumulative.cacheRead - (previousCumulative?.cacheRead ?? 0)) }
    : {}),
  ...(currentCumulative.cacheWrite !== undefined
    ? { cacheWrite: floorUsage(currentCumulative.cacheWrite - (previousCumulative?.cacheWrite ?? 0)) }
    : {}),
});

/** Delta cost between cumulative snapshots; undefined when no change. */
export const deltaCost = (
  previousCumulative: number | undefined,
  currentCumulative: number | undefined,
): number | undefined => {
  if (currentCumulative === undefined) return undefined;
  const prev = previousCumulative ?? 0;
  const delta = currentCumulative - prev;
  if (!Number.isFinite(delta) || delta <= 0) return undefined;
  return delta;
};

const browserCapture = (ref: {
  kind?: string;
  browserContext?: {
    crop?: { localPath?: string; mime?: string };
    screenshot?: { localPath?: string; mime?: string };
  };
}): { localPath: string; mime: string } | undefined => {
  if (ref.kind !== "browser-context") return undefined;
  const shot = ref.browserContext?.crop ?? ref.browserContext?.screenshot;
  if (!shot?.localPath || !shot.mime?.startsWith("image/")) return undefined;
  return { localPath: shot.localPath, mime: shot.mime };
};

/** Merge browser-context text into the prompt and collect materialized captures. */
export const composeTurnPrompt = (
  text: string,
  attachments?: readonly AttachmentRef[],
): { text: string; images: Array<{ localPath: string; mime: string }> } => {
  const images: Array<{ localPath: string; mime: string }> = [];
  const browserTexts: string[] = [];
  for (const ref of attachments ?? []) {
    if (ref.kind !== "browser-context") continue;
    if (ref.browserContext) browserTexts.push(formatBrowserContextForModel(ref.browserContext));
    const shot = browserCapture(ref);
    if (shot) images.push(shot);
  }
  return {
    text: browserTexts.length
      ? (text.trim() ? `${text}\n\n${browserTexts.join("\n\n")}` : browserTexts.join("\n\n"))
      : text,
    images,
  };
};

