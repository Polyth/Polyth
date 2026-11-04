import { useEffect, useRef } from "react";
import { clockText } from "./format.ts";
import type { LogLine } from "./model.ts";
import type { Words } from "./strings.ts";

const NEAR_END_PX = 64;
const scrollerOf = (element: HTMLElement | null): HTMLElement | null => {
  for (let parent = element?.parentElement ?? null; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
};

/** Newest at the bottom, followed while the reader stays at the end. */
export function LogLines({ lines, filter, truncated, locale, t, onFollowing }: {
  lines: LogLine[]; filter: "all" | "problems"; truncated: boolean; locale: string; t: Words; onFollowing: (following: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const shown = filter === "problems" ? lines.filter((line) => line.problem) : lines;
  useEffect(() => {
    const scroller = scrollerOf(root.current);
    if (scroller && following.current) scroller.scrollTop = scroller.scrollHeight;
  }, [shown.length, shown.at(-1)?.text]);
  useEffect(() => {
    const scroller = scrollerOf(root.current);
    if (!scroller) return undefined;
    const update = () => {
      const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_END_PX;
      if (near !== following.current) { following.current = near; onFollowing(near); }
    };
    scroller.addEventListener("scroll", update, { passive: true });
    return () => { scroller.removeEventListener("scroll", update); onFollowing(true); };
  }, [lines.length > 0, onFollowing]);
  return <div ref={root} className="pkg-monitoring-logs">
    {truncated && <p className="pkg-monitoring-note">{t("Older content omitted", "Старіший вміст пропущено")}</p>}
    {shown.length
      ? <div className="pkg-monitoring-log" role="log" tabIndex={0} aria-label={t("Log output", "Вміст логів")}>
        {shown.map((line, index) => <div key={`${index}:${line.at ?? ""}:${line.text}`} {...(line.problem ? { "data-problem": "" } : {})}>
          {line.at !== undefined && <time dateTime={new Date(line.at).toISOString()}>{clockText(line.at, locale, true)}</time>}
          <span>{line.text}</span>
        </div>)}
      </div>
      : <p className="pkg-monitoring-note">{filter === "problems" ? t("No problems in these lines.", "У цих рядках немає проблем.") : t("No log entries", "Немає записів")}</p>}
    <p className="pkg-monitoring-note">{t("Last 200 lines, newest at the bottom.", "Останні 200 рядків, найновіші внизу.")}</p>
  </div>;
}
