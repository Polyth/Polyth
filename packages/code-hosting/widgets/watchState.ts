import type { ChangeRequestWatchView } from "@polyth/code-hosting";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Tone = "failure" | "running" | "success" | "waiting" | "quiet";

/** One run of the line's words, inked by what it says. */
export interface WatchStatePart {
  text: string;
  tone: Tone | "names";
}

/** The state words of the line and its tone, most important first. Each part
 *  keeps its own ink: a failure reads red, what still runs stays neutral. */
export function watchState(view: ChangeRequestWatchView, t: Translate): { text: string; tone: Tone; parts: WatchStatePart[] } {
  const { checks } = view;
  const single = (text: string, tone: Tone) => ({ text, tone, parts: [{ text, tone }] });
  if (view.lastError) return single(t("prwatch.retrying"), "waiting");
  if (view.waiting) return single(t("prwatch.waitingForChat"), "waiting");
  // What failed outranks what still runs: on a narrow line the names stay.
  const parts: WatchStatePart[] = [];
  if (checks.failed) {
    parts.push({ text: t("prwatch.failed", { count: checks.failed }), tone: "failure" });
    if (view.failedChecks.length) {
      parts.push({ text: `${view.failedChecks.slice(0, 2).join(", ")}${view.failedChecks.length > 2 ? "…" : ""}`, tone: "names" });
    }
  }
  if (checks.running) parts.push({ text: t("prwatch.running", { count: checks.running }), tone: "running" });
  if (parts.length) return { text: parts.map((part) => part.text).join(" · "), tone: checks.failed ? "failure" : "running", parts };
  if (checks.total && checks.passed) return single(t("prwatch.allPassed"), "success");
  return single(t("prwatch.noChecks"), "quiet");
}
