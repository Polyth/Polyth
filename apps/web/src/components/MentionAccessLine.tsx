// A mentioned person who cannot open the chat: one line of the pending stack
// above the composer. It asks once whether to open the chat to them (or to ask
// whoever can), and once answered it says what the message will do. The answer
// takes effect with the message, never before, so a mention deleted from the
// draft has opened nothing. Copy keeps names in the nominative: a sentence never
// has to decline one.
import type { Ref } from "react";
import type { SessionAccessLevel, SessionMentionOutsidersDto } from "@polyth/contracts";
import type { MentionAccessLine as Line } from "../composer/people.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { personToneOf } from "../personIdentity.ts";
import { firstNamesList } from "../sessionPeople.ts";
import { accessLabel } from "../sessionSharing.ts";
import { CheckIcon, ChevronDownIcon, CloseIcon, Icon as UiIcon, IconButton, Menu } from "./ui/index.ts";

export default function MentionAccessLine({
  line,
  outsiders,
  tones,
  level,
  attention,
  primaryRef,
  onAnswer,
  onSkip,
  onUndo,
  onLevel,
}: {
  line: Line;
  outsiders: SessionMentionOutsidersDto;
  /** The colours the `@` list uses, so a person looks the same in both. */
  tones: ReadonlyMap<string, number>;
  level: SessionAccessLevel;
  /** Grows each time a send was stopped to wait for an answer. */
  attention: number;
  primaryRef: Ref<HTMLButtonElement>;
  onAnswer(): void;
  onSkip(): void;
  onUndo(): void;
  onLevel(level: SessionAccessLevel): void;
}) {
  const first = line.people[0];
  if (!first) return null;
  const names = firstNamesList(line.people.map((person) => person.name), getLocale());
  const many = line.people.length > 1;
  const approver = firstNamesList([outsiders.approver?.name ?? outsiders.approver?.userId ?? ""], getLocale());
  const text = (() => {
    if (line.state === "blocked") return tr(many ? "composer.people.access.blockedMany" : "composer.people.access.blockedOne", { names });
    if (line.state === "granted") {
      return line.action === "share"
        ? tr(many ? "composer.people.access.grantedMany" : "composer.people.access.grantedOne", { names })
        : tr("composer.people.access.requested", { name: approver });
    }
    return line.action === "share"
      ? tr(many ? "composer.people.access.askMany" : "composer.people.access.askOne", { names })
      : tr(many ? "composer.people.access.requestMany" : "composer.people.access.requestOne", { names, name: approver });
  })();
  const dismissLabel = line.state === "granted"
    ? tr("composer.people.access.undo")
    : line.state === "ask" && line.action === "request"
      ? tr("composer.people.access.dontRequest")
      : line.state === "ask"
        ? tr("composer.people.access.dontShare")
        : tr("composer.dismiss");
  const sharing = line.state !== "blocked" && line.action === "share";
  return (
    <div
      className="mention-access"
      role="group"
      aria-label={tr("composer.people.access.label")}
      data-state={line.state}
      {...(attention > 0 && line.state === "ask" ? { "data-attention": "" } : {})}
    >
      <div className="mention-access-row">
        {line.state === "granted"
          ? <span className="mention-access-check" aria-hidden="true"><UiIcon icon={CheckIcon} size="sm" /></span>
          : (
            <span className="person-mark mention-access-mark" data-person-tone={personToneOf(tones, first.userId) ?? undefined} aria-hidden="true">
              {[...first.name.trim()][0]?.toLocaleUpperCase() ?? "?"}
            </span>
          )}
        {/* A restart of the key replays the nudge. */}
        <span key={attention} className="mention-access-text" aria-live="polite">{text}</span>
        {line.state === "ask" && (
          <button
            ref={primaryRef}
            type="button"
            className="mention-access-action is-primary"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAnswer}
          >
            {line.action === "share" ? tr("composer.people.access.share") : tr("composer.people.access.request")}
          </button>
        )}
        {line.state === "granted" && line.action === "share" && (outsiders.levels.length > 1
          ? (
            <Menu
              label={tr("sharing.accessFor", { name: names })}
              entries={outsiders.levels.map((choice) => ({
                id: choice,
                label: accessLabel(choice),
                kind: "radio" as const,
                checked: choice === level,
                onSelect: () => onLevel(choice),
              }))}
            >
              {(trigger) => (
                <button {...trigger} type="button" className="mention-access-action mention-access-level">
                  {accessLabel(level)}
                  <UiIcon icon={ChevronDownIcon} size="sm" />
                </button>
              )}
            </Menu>
          )
          : <span className="mention-access-level is-static">{accessLabel(level)}</span>)}
        <IconButton
          className="mention-access-dismiss"
          icon={CloseIcon}
          label={dismissLabel}
          size="sm"
          variant="ghost"
          onMouseDown={(event) => event.preventDefault()}
          onClick={line.state === "granted" ? onUndo : onSkip}
        />
      </div>
      {sharing && outsiders.personalMcpDetachedOnShare && (
        <p className="mention-access-note">{tr("sharing.personalMcpDetached")}</p>
      )}
    </div>
  );
}
