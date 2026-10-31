// Captured command output, rendered like the terminal it came from: palette
// colours from the theme's terminal tokens, progress lines collapsed, and the
// view pinned to the newest line until the reader scrolls up.
import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { terminalLines, type AnsiSegment } from "../src/terminalText.ts";

const segmentClass = (segment: AnsiSegment): string => {
  const classes: string[] = [];
  if (typeof segment.fg === "number") classes.push(`ca-fg-${segment.fg}`);
  if (typeof segment.bg === "number") classes.push(`ca-bg-${segment.bg}`);
  if (segment.bold) classes.push("ca-b");
  if (segment.dim) classes.push("ca-dim");
  if (segment.italic) classes.push("ca-i");
  if (segment.underline) classes.push("ca-u");
  if (segment.inverse) classes.push("ca-inv");
  return classes.join(" ");
};

const segmentStyle = (segment: AnsiSegment): CSSProperties | undefined => {
  // 256-colour and true-colour values are the program's own data.
  const style: CSSProperties = {};
  if (typeof segment.fg === "string") style.color = segment.fg;
  if (typeof segment.bg === "string") style.backgroundColor = segment.bg;
  return style.color || style.backgroundColor ? style : undefined;
};

export default function TerminalOutput({
  text,
  live,
  emptyLabel,
  label,
  className,
}: {
  text: string;
  live: boolean;
  emptyLabel: string;
  label: string;
  className?: string;
}) {
  const lines = useMemo(() => terminalLines(text), [text]);
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  const empty = lines.length === 1 && lines[0]!.length === 0;
  return (
    <pre
      ref={scroller}
      className={`ca-term ui-scroll${className ? ` ${className}` : ""}`}
      data-live={live || undefined}
      tabIndex={0}
      aria-label={label}
      aria-busy={live || undefined}
    >
      {empty
        ? <span className="ca-term-empty">{emptyLabel}</span>
        : lines.map((segments, row) => (
          <span key={row} className="ca-term-line">
            {segments.map((segment, index) => {
              const className = segmentClass(segment);
              const style = segmentStyle(segment);
              return className || style
                ? <span key={index} {...(className ? { className } : {})} {...(style ? { style } : {})}>{segment.text}</span>
                : segment.text;
            })}
            {"\n"}
          </span>
        ))}
      {live && <span className="ca-term-caret" aria-hidden="true" />}
    </pre>
  );
}
