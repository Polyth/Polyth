import { useEffect, useRef, useState, type RefObject } from "react";
import { activePromptIndex } from "../promptRail.ts";
import { promptJumpName } from "../messageActions.ts";
import { tr } from "../i18n/index.ts";
import { IconButton } from "./ui/index.ts";
import { CollapseIcon, ExpandIcon } from "./ui/icons.ts";

const AUTO_DISMISS_MS = 5000;

/** Transient top-center bubble shown while the active prompt is scrolled out
 *  of view and no prompt rail exists (fewer than three prompts). Re-shows on
 *  scroll activity, auto-dismisses 5s after the last scroll, and never
 *  dismisses while hovered. Click scrolls to the prompt; the toggle expands
 *  the full text in place. */
export default function PromptBubble({
  prompts,
  containerRef,
  onJump,
}: {
  prompts: Array<{ id: string; preview: string; text: string }>;
  containerRef: RefObject<HTMLDivElement | null>;
  onJump: (id: string) => void;
}) {
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  };
  const startTimer = () => {
    clearTimer();
    timer.current = setTimeout(() => { timer.current = null; setShown(false); }, AUTO_DISMISS_MS);
  };

  // Only show the bubble for a prompt that is currently rendered and above the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const box = el.getBoundingClientRect();
      const line = box.top + el.clientHeight * 0.5;
      const tops = prompts.map((p) => {
        const node = el.querySelector(`[data-msg-id="${p.id}"]`);
        return node === null ? null : node.getBoundingClientRect().top;
      });
      const index = activePromptIndex(tops, line);
      const top = index >= 0 ? (tops[index] ?? null) : null;
      setActive(Math.max(0, index));
      const offScreen = index >= 0 && top !== null && top < box.top;
      if (offScreen) { setShown(true); startTimer(); }
      else { setShown(false); clearTimer(); }
    };
    const onScroll = () => { if (raf === 0) raf = requestAnimationFrame(measure); };
    el.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
      clearTimer();
    };
  }, [prompts, containerRef]);

  if (!shown) return null;
  const p = prompts[Math.min(active, prompts.length - 1)];
  if (p === undefined) return null;
  const name = promptJumpName(active, prompts.length, p.text);
  const toggleName = expanded ? tr("timeline.promptBubble.collapse") : tr("timeline.promptBubble.expand");
  return (
    <div
      className="prompt-bubble"
      data-expanded={expanded || undefined}
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
    >
      <button
        type="button"
        className="prompt-bubble-main"
        title={name}
        aria-label={name}
        onClick={() => onJump(p.id)}
      >
        <span className="prompt-bubble-text">{expanded ? p.text : p.preview}</span>
      </button>
      <IconButton
        className="prompt-bubble-toggle"
        icon={expanded ? CollapseIcon : ExpandIcon}
        label={toggleName}
        size="sm"
        variant="ghost"
        pressed={expanded}
        onClick={() => setExpanded((v) => !v)}
      />
    </div>
  );
}
