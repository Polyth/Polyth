// Small presentation helpers of the Memory page: a list field drawn as chips,
// the search match highlight and a record's age in words.
import { Fragment, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { isImeComposing } from "@polyth/web-sdk";
import { TextField } from "./ui.tsx";

/** Values typed into a list field: commas and line breaks separate them. */
export const splitList = (value: string): string[] => value.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);

/**
 * A list of short values (tags, paths, sources) as removable chips with one
 * input after them. Enter, a comma or leaving the field adds what was typed;
 * Backspace in an empty input takes the last chip back for editing. A pasted
 * "a, b, c" becomes three chips.
 */
export function ListField({ id, values, onChange, placeholder, removeLabel, max, maxLength, describedBy, disabled }: {
  id: string;
  values: readonly string[];
  onChange(values: string[]): void;
  placeholder?: string;
  removeLabel(value: string): string;
  max: number;
  maxLength: number;
  describedBy?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const full = values.length >= max;
  const add = (text: string): boolean => {
    const next = [...values];
    for (const part of splitList(text)) {
      const value = part.slice(0, maxLength);
      if (next.length >= max) break;
      if (!next.some((existing) => existing.toLowerCase() === value.toLowerCase())) next.push(value);
    }
    if (next.length !== values.length) onChange(next);
    return true;
  };
  const type = (text: string) => {
    if (/[,\n]/.test(text)) {
      const parts = text.split(/[,\n]/);
      const rest = parts.pop() ?? "";
      add(parts.join(","));
      setDraft(rest.trimStart());
      return;
    }
    setDraft(text);
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Enter" && draft.trim()) { event.preventDefault(); add(draft); setDraft(""); return; }
    if (event.key === "Backspace" && !draft && values.length) {
      event.preventDefault();
      const last = values[values.length - 1]!;
      onChange(values.slice(0, -1));
      setDraft(last);
    }
  };
  return (
    <div
      className="memory-list-field ui-field-well"
      data-disabled={disabled || undefined}
      onClick={(event) => { if (event.target === event.currentTarget) input.current?.focus(); }}
    >
      {values.map((value) => (
        <span key={value} className="memory-list-chip">
          <span className="memory-list-chip-text">{value}</span>
          <button type="button" className="memory-list-chip-remove" aria-label={removeLabel(value)} disabled={disabled} onClick={() => { onChange(values.filter((item) => item !== value)); input.current?.focus(); }}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" /></svg>
          </button>
        </span>
      ))}
      {!full && (
        <TextField
          id={id}
          inputRef={input}
          className="memory-list-input"
          value={draft}
          onChange={type}
          onKeyDown={key}
          onBlur={() => { if (draft.trim()) { add(draft); setDraft(""); } }}
          enterKeyHint="done"
          autoComplete="off"
          {...(values.length === 0 && placeholder ? { placeholder } : {})}
          {...(describedBy ? { "aria-describedby": describedBy } : {})}
          {...(disabled ? { disabled } : {})}
        />
      )}
    </div>
  );
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words of a search worth marking: two characters or more. */
export const searchWords = (query: string): string[] =>
  [...new Set(query.toLocaleLowerCase().split(/\s+/).filter((word) => word.length >= 2))];

/** `text` with every searched word marked. */
export function Highlight({ text, words }: { text: string; words: readonly string[] }): ReactNode {
  if (!words.length || !text) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "giu");
  const parts = text.split(pattern);
  return parts.map((part, index) => index % 2 === 1
    ? <mark key={index} className="memory-mark">{part}</mark>
    : <Fragment key={index}>{part}</Fragment>);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400_000], ["month", 30 * 86_400_000], ["week", 7 * 86_400_000],
  ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000],
];

/** "2 days ago", "yesterday", "now" in the host locale. */
export function ageOf(time: number, now: number, format: Intl.RelativeTimeFormat): string {
  const elapsed = time - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) return format.format(Math.round(elapsed / size), unit);
  }
  return format.format(0, "minute");
}
