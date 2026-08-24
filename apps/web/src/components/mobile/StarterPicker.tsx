// UX-MOBILE-01 §35: the full quick-starter catalog behind the hero's "+"
// chip. Browse every starter (built-in and custom), pin the ones that should
// live on the hero, or author a new one — all inside the shared bottom sheet.
import { useState, type ReactNode } from "react";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";
import { Icon } from "../../icons.tsx";
import {
  addCustomStarter,
  allStarters,
  removeCustomStarter,
  toggleStarterPinned,
  useStarterPrefs,
  type Starter,
  type StarterContext,
} from "../../starters.ts";

const STARTER_ICONS: Record<string, () => ReactNode> = {
  diff: () => <Icon.compare />,
  commit: () => <Icon.commit />,
  resume: () => <Icon.rewind />,
  explore: () => <Icon.search />,
  plan: () => <Icon.plan />,
  bug: () => <Icon.target />,
  tests: () => <Icon.shield />,
  chat: () => <Icon.chat />,
  files: () => <Icon.files />,
  pencil: () => <Icon.pencil />,
};

const ICON_CHOICES = Object.keys(STARTER_ICONS);

/** Glyph for a starter's icon key; unknown keys fall back to the chat mark. */
export function StarterIcon({ id }: { id: string }) {
  const render = STARTER_ICONS[id] ?? STARTER_ICONS["chat"]!;
  return <>{render()}</>;
}

function NewStarterForm({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [icon, setIcon] = useState(ICON_CHOICES[0] ?? "chat");
  const valid = label.trim().length > 0 && prompt.trim().length > 0;
  return (
    <form
      className="starter-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        addCustomStarter({ label: label.trim(), prompt: prompt.trim(), icon });
        onDone();
      }}
    >
      <label className="starter-field">
        <span>Label</span>
        <input
          value={label}
          placeholder="e.g. Update the changelog"
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className="starter-field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          rows={3}
          placeholder="What should the agent do?"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <div className="starter-field">
        <span>Icon</span>
        <div className="starter-icon-choices" role="radiogroup" aria-label="Starter icon">
          {ICON_CHOICES.map((key) => (
            <button
              key={key}
              type="button"
              className={`starter-icon-choice${icon === key ? " on" : ""}`}
              role="radio"
              aria-checked={icon === key}
              aria-label={key}
              onClick={() => setIcon(key)}
            >
              <StarterIcon id={key} />
            </button>
          ))}
        </div>
      </div>
      <div className="starter-form-actions">
        <button type="button" onClick={onDone}>Cancel</button>
        <button type="submit" className="primary-btn" disabled={!valid}>Add starter</button>
      </div>
    </form>
  );
}

export default function StarterPicker({
  context,
  onPick,
  onClose,
}: {
  context: StarterContext;
  onPick: (starter: Starter) => void;
  onClose: () => void;
}) {
  const prefs = useStarterPrefs();
  const [creating, setCreating] = useState(false);
  const starters = allStarters(prefs);
  const pinned = starters.filter((starter) => prefs.pinned.includes(starter.id));
  const rest = starters.filter((starter) => !prefs.pinned.includes(starter.id));

  const row = (starter: Starter) => {
    const isPinned = prefs.pinned.includes(starter.id);
    const isCustom = prefs.custom.some((candidate) => candidate.id === starter.id);
    return (
      <SheetRow
        key={starter.id}
        title={starter.label}
        {...(starter.description ? { meta: starter.description } : {})}
        icon={<StarterIcon id={starter.icon} />}
        onClick={() => {
          onPick(starter);
          onClose();
        }}
        ariaLabel={`Run starter: ${starter.label}`}
        trailing={
          <span className="sheet-row-tools">
            <button
              type="button"
              className={`sheet-row-star${isPinned ? " on" : ""}`}
              aria-label={isPinned ? `Unpin ${starter.label}` : `Pin ${starter.label}`}
              aria-pressed={isPinned}
              onClick={() => toggleStarterPinned(starter.id)}
            >
              <Icon.bookmark />
            </button>
            {isCustom && (
              <button
                type="button"
                className="sheet-row-tool danger"
                aria-label={`Delete ${starter.label}`}
                onClick={() => removeCustomStarter(starter.id)}
              >
                <Icon.trash />
              </button>
            )}
          </span>
        }
      />
    );
  };

  // Context-fitting suggestions surface first so "right now" work leads.
  const suggested = rest.filter((starter) =>
    context.dirty
      ? ["review-changes", "commit-message", "continue-work"].includes(starter.id)
      : !["review-changes", "commit-message"].includes(starter.id));
  const others = rest.filter((starter) => !suggested.includes(starter));

  return (
    <Sheet
      title="Quick starters"
      onClose={onClose}
      {...(creating ? {} : {
        action: { label: "New", onClick: () => setCreating(true) },
      })}
    >
      {creating ? (
        <NewStarterForm onDone={() => setCreating(false)} />
      ) : (
        <>
          {pinned.length > 0 && (
            <SheetSection title="Pinned" count={pinned.length}>
              {pinned.map(row)}
            </SheetSection>
          )}
          {suggested.length > 0 && (
            <SheetSection title="Suggested" count={suggested.length}>
              {suggested.map(row)}
            </SheetSection>
          )}
          {others.length > 0 && (
            <SheetSection title="More" count={others.length}>
              {others.map(row)}
            </SheetSection>
          )}
        </>
      )}
    </Sheet>
  );
}
