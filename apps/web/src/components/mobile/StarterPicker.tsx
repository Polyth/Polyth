// UX-MOBILE-01 §6/§7/§33/§48: the starter picker. A sheet (never a floating
// desktop dialog on a phone) with a sticky search row, sticky category heads,
// ≥48px rows, pin/hide controls, an explicit Edit mode for reordering
// favorites (§27), and a form for user-authored starters.
import { useMemo, useState } from "react";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";
import { Icon } from "../../icons.tsx";
import {
  deleteCustomStarter,
  matchesStarter,
  newCustomStarterId,
  noteStarterUsed,
  reorderStarters,
  setStarterHidden,
  starterCategories,
  saveCustomStarter,
  toggleStarterPinned,
  useStarterPrefs,
  type Starter,
  type StarterContext,
  type StarterIconId,
} from "../../starters.ts";
import { tr } from "../../i18n/index.ts";
import { Button } from "../ui/index.ts";

const ICONS: Record<StarterIconId, () => React.ReactElement> = {
  target: Icon.target,
  branch: Icon.branch,
  files: Icon.files,
  plan: Icon.plan,
  book: Icon.book,
  shield: Icon.shield,
  term: Icon.term,
  pencil: Icon.pencil,
  search: Icon.search,
  commit: Icon.commit,
  check: Icon.check,
  chat: Icon.chat,
  puzzle: Icon.puzzle,
  sync: Icon.sync,
  fileEdit: Icon.fileEdit,
  list: Icon.list,
  bookmark: Icon.bookmark,
};

const ICON_CHOICES: readonly StarterIconId[] = [
  "bookmark", "target", "plan", "search", "check", "commit", "branch",
  "files", "fileEdit", "term", "book", "shield", "puzzle", "sync", "list", "chat", "pencil",
];

export function StarterIcon({ id }: { id: StarterIconId }) {
  const Glyph = ICONS[id] ?? Icon.bookmark;
  return <Glyph />;
}

interface FormState {
  id?: string;
  label: string;
  prompt: string;
  icon: StarterIconId;
}

export interface StarterPickerProps {
  context: StarterContext;
  commands?: Array<{ name: string; description?: string }>;
  skills?: Array<{ name: string; description?: string }>;
  onPick: (starter: Starter) => void;
  onClose: () => void;
}

export default function StarterPicker({ context, commands, skills, onPick, onClose }: StarterPickerProps) {
  const prefs = useStarterPrefs();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);

  const categories = useMemo(
    () => starterCategories(prefs, context, { ...(commands ? { commands } : {}), ...(skills ? { skills } : {}) }),
    [prefs, context, commands, skills],
  );
  const results = useMemo(() => {
    if (query.trim() === "") return null;
    const seen = new Set<string>();
    const hits: Starter[] = [];
    for (const category of categories) {
      for (const starter of category.starters) {
        if (seen.has(starter.id) || !matchesStarter(starter, query)) continue;
        seen.add(starter.id);
        hits.push(starter);
      }
    }
    return hits;
  }, [categories, query]);

  const pick = (starter: Starter) => {
    noteStarterUsed(starter.id);
    onPick(starter);
    onClose();
  };

  const moveFavorite = (id: string, delta: number) => {
    const index = prefs.pinned.indexOf(id);
    const target = prefs.pinned[index + delta];
    if (target) reorderStarters(id, target);
  };

  const row = (starter: Starter, group: string) => {
    const pinned = prefs.pinned.includes(starter.id);
    const favoriteRow = group === "favorites";
    const position = prefs.pinned.indexOf(starter.id);
    return (
      <SheetRow
        key={`${group}:${starter.id}`}
        title={starter.label}
        {...(starter.description ? { meta: starter.description } : {})}
        icon={<StarterIcon id={starter.icon} />}
        onClick={() => (editing && starter.source === "custom"
          ? setForm({ id: starter.id, label: starter.label, prompt: starter.prompt, icon: starter.icon })
          : pick(starter))}
        ariaLabel={editing && starter.source === "custom"
          ? tr("mobile.starterpicker.editStarterValue", { label: starter.label })
          : tr("mobile.starterpicker.startValue", { label: starter.label })}
        trailing={editing ? (
          <span className="sheet-row-tools">
            {favoriteRow && (
              <>
                <button
                  type="button"
                  className="sheet-row-tool"
                  aria-label={tr("mobile.starterpicker.moveValueUp", { label: starter.label })}
                  disabled={position <= 0}
                  onClick={() => moveFavorite(starter.id, -1)}
                >↑</button>
                <button
                  type="button"
                  className="sheet-row-tool"
                  aria-label={tr("mobile.starterpicker.moveValueDown", { label: starter.label })}
                  disabled={position < 0 || position >= prefs.pinned.length - 1}
                  onClick={() => moveFavorite(starter.id, 1)}
                >↓</button>
              </>
            )}
            {starter.source === "custom" ? (
              <button
                type="button"
                className="sheet-row-tool danger"
                aria-label={tr("mobile.starterpicker.deleteStarterValue", { label: starter.label })}
                onClick={() => deleteCustomStarter(starter.id)}
              ><Icon.trash /></button>
            ) : (
              <button
                type="button"
                className="sheet-row-tool"
                aria-label={prefs.hidden.includes(starter.id)
                  ? tr("mobile.starterpicker.showValueInSuggestions", { label: starter.label })
                  : tr("mobile.starterpicker.hideValueFromSuggestions", { label: starter.label })}
                aria-pressed={prefs.hidden.includes(starter.id)}
                onClick={() => setStarterHidden(starter.id, !prefs.hidden.includes(starter.id))}
              >{prefs.hidden.includes(starter.id) ? <Icon.check /> : <Icon.close />}</button>
            )}
          </span>
        ) : (
          <button
            type="button"
            className={`sheet-row-star${pinned ? " on" : ""}`}
            aria-label={pinned
              ? tr("mobile.starterpicker.unpinValue", { value: starter.label })
              : tr("mobile.starterpicker.pinValue", { value: starter.label })}
            aria-pressed={pinned}
            onClick={() => toggleStarterPinned(starter.id)}
          >
            <Icon.bookmark />
          </button>
        )}
      />
    );
  };

  if (form) {
    const valid = form.label.trim() !== "" && form.prompt.trim() !== "";
    return (
      <Sheet
        title={form.id ? tr("mobile.starterpicker.editStarter") : tr("mobile.starterpicker.newStarter")}
        size="tall"
        className="starter-sheet"
        onClose={() => setForm(null)}
      >
        <div className="starter-form">
          <label className="starter-field">
            <span>{tr("mobile.starterpicker.name")}</span>
            <input
              value={form.label}
              maxLength={40}
              placeholder={tr("mobile.starterpicker.reviewMyChanges")}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
            />
          </label>
          <label className="starter-field">
            <span>{tr("mobile.starterpicker.prompt")}</span>
            <textarea
              value={form.prompt}
              rows={4}
              placeholder={tr("mobile.starterpicker.whatShouldTheAgentDoWhenThis")}
              onChange={(event) => setForm({ ...form, prompt: event.target.value })}
            />
          </label>
          <div className="starter-field">
            <span>{tr("mobile.starterpicker.icon")}</span>
            <div className="starter-icon-choices" role="radiogroup" aria-label={tr("mobile.starterpicker.starterIcon")}>
              {ICON_CHOICES.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  role="radio"
                  aria-checked={form.icon === icon}
                  aria-label={tr("mobile.starterpicker.iconValue", { icon: icon })}
                  className={`starter-icon-choice${form.icon === icon ? " on" : ""}`}
                  onClick={() => setForm({ ...form, icon })}
                ><StarterIcon id={icon} /></button>
              ))}
            </div>
          </div>
          <div className="starter-form-actions">
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>{tr("common.cancel")}</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!valid}
              onClick={() => {
                saveCustomStarter({
                  id: form.id ?? newCustomStarterId(),
                  label: form.label.trim(),
                  prompt: form.prompt.trim(),
                  icon: form.icon,
                });
                setForm(null);
              }}
            >{tr("mobile.starterpicker.saveStarter")}</Button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={tr("mobile.starterpicker.addAStarter")}
      size="tall"
      className="starter-sheet"
      onClose={onClose}
      search={{
        value: query,
        onChange: setQuery,
        placeholder: tr("mobile.starterpicker.searchStartersCommandsSkills"),
        ariaLabel: "Search starters",
      }}
      action={{
        label: editing ? tr("common.done") : tr("common.edit"),
        pressed: editing,
        onClick: () => setEditing((value) => !value),
      }}
      footer={
        <button
          type="button"
          className="sheet-foot-action"
          onClick={() => setForm({ label: "", prompt: "", icon: "bookmark" })}
        >
          <Icon.plus /><span>{tr("mobile.starterpicker.createAStarter")}</span>
        </button>
      }
    >
      <div role="listbox" aria-label={tr("mobile.starterpicker.starters")}>
        {results
          ? results.length > 0
            ? <SheetSection title={tr("mobile.starterpicker.results")} count={results.length}>{results.map((starter) => row(starter, "results"))}</SheetSection>
            : <p className="sheet-empty">{tr("mobile.starterpicker.noStartersMatch")}{query}”.</p>
          : categories.map((category) => (
            <SheetSection key={category.id} title={category.title} count={category.starters.length}>
              {category.starters.map((starter) => row(starter, category.id))}
            </SheetSection>
          ))}
      </div>
    </Sheet>
  );
}
