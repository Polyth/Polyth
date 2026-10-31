// The new chat's touch edit mode — how phones and tablets customize the
// screen (a mouse uses Shift or the workspace Edit mode and the hero's pencil).
// A long press anywhere on the screen enters it, as on a phone's home screen:
// the widgets wobble and their content stops taking taps, each tile gets a
// hide badge and a grip (HeroWidgets.tsx), and a toolbar under them offers
// Add widget and the full Customize panel. Done (the phone header's actions
// island, or the toolbar elsewhere), Escape, a tap on empty space, leaving
// the screen or switching project end it.
import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { tr } from "../../i18n/index.ts";
import { tapFeedback } from "../../haptics.ts";
import { dismissKeyboard } from "../../mobileViewport.ts";
import { openHeroPanel, setHeroEditing, useHeroEditing } from "../../heroEditing.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { Button, PlusIcon, ViewOptionsIcon } from "../ui/index.ts";

export const HERO_LONG_PRESS_MS = 550;
const MOVE_TOLERANCE = 6;
/** A press here edits text or is already an edit control. */
const NO_LONG_PRESS = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .hero-widget-edit, .hero-edit-toolbar, .hero-customize-trigger";

/** True for a target inside the hero's own DOM. React events bubble through
 *  portals, so a press inside the Customize sheet reaches the hero's handlers
 *  too; it must neither start a hold nor count as a tap on empty space. */
function ownTarget(event: { currentTarget: HTMLElement; target: EventTarget }): Element | null {
  const target = event.target as Element;
  return typeof target.closest === "function" && event.currentTarget.contains(target) ? target : null;
}

/** Props for the hero body: the long press that enters the mode, and the
 *  taps that leave it. */
export function useHeroEditGesture(projectId: string | null) {
  const editing = useHeroEditing();
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // The click that ends a long press must not also press what was under it.
  const swallowClick = useRef(false);

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  useEffect(() => () => {
    cancel();
    setHeroEditing(false);
  }, [projectId]);

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeroEditing(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  return {
    "data-editing": editing ? "true" : undefined,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      // A browser that sends no click after a hold leaves the flag set.
      swallowClick.current = false;
      const target = ownTarget(event);
      if (event.pointerType !== "touch" || editing || !target || target.closest(NO_LONG_PRESS)) return;
      cancel();
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        start.current = null;
        swallowClick.current = true;
        tapFeedback();
        void dismissKeyboard();
        setHeroEditing(true);
      }, HERO_LONG_PRESS_MS);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const origin = start.current;
      if (!origin) return;
      if (Math.abs(event.clientX - origin.x) > MOVE_TOLERANCE || Math.abs(event.clientY - origin.y) > MOVE_TOLERANCE) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onScroll: cancel,
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      // Android raises the context menu at the same hold.
      if (timer.current !== null || swallowClick.current || editing) event.preventDefault();
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = ownTarget(event);
      if (editing && target && !target.closest(".hero-widget, .hero-edit-toolbar, .hero-customize-trigger")) setHeroEditing(false);
    },
  };
}

/** Under the widgets while the mode is on. Phones end it from the header. */
export function HeroEditToolbar() {
  const editing = useHeroEditing();
  const phone = useShellMode() === "phone";
  if (!editing) return null;
  return (
    <div className="hero-edit-toolbar" role="toolbar" aria-label={tr("workspace.herocustomize.editing")}>
      <Button size="sm" iconStart={PlusIcon} onClick={() => openHeroPanel("add")}>{tr("workspace.herocustomize.addWidget")}</Button>
      <Button size="sm" iconStart={ViewOptionsIcon} onClick={() => openHeroPanel()}>{tr("workspace.herocustomize.allSettings")}</Button>
      {!phone && <Button size="sm" variant="primary" onClick={() => setHeroEditing(false)}>{tr("common.done")}</Button>}
    </div>
  );
}
