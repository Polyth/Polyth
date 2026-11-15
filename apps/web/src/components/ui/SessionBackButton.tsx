// Back from a chat to where it belongs: a delegated child's parent chat, or
// the package page that owns the session (an agent's page). Every caller
// draws the same control. The host draws the parent's (SessionBack.tsx);
// a package draws its own through the `session.header.back` slot.
import type { ReactNode } from "react";
import { tr } from "../../i18n/index.ts";
import Icon from "./Icon.tsx";
import IconButton from "./IconButton.tsx";
import { ChevronLeftIcon } from "./icons.ts";

/** "bar": a quiet pill before the chat title (desktop and tablet).
 *  "island": an icon button in the phone's leading island, beside the menu. */
export type SessionBackPresentation = "bar" | "island";

export interface SessionBackButtonProps {
  /** Where Back goes, in words: the parent chat's title, the agent's name. */
  label: string;
  onBack: () => void;
  presentation?: SessionBackPresentation;
  /** A mark between the arrow and the label (an agent's glyph). Bar only. */
  mark?: ReactNode;
  className?: string;
}

export default function SessionBackButton({ label, onBack, presentation = "bar", mark, className }: SessionBackButtonProps) {
  const name = tr("sessionback.backToValue", { name: label });
  if (presentation === "island") {
    return (
      <IconButton
        icon={ChevronLeftIcon}
        label={name}
        size="lg"
        variant="ghost"
        className={`session-back session-back--island${className ? ` ${className}` : ""}`}
        title={name}
        onClick={onBack}
      />
    );
  }
  return (
    <button
      type="button"
      className={`session-back session-back--bar header-control${className ? ` ${className}` : ""}`}
      aria-label={name}
      title={name}
      onClick={onBack}
    >
      <Icon icon={ChevronLeftIcon} size="sm" className="session-back-arrow" />
      {mark}
      <span className="session-back-label" dir="auto">{label}</span>
    </button>
  );
}
