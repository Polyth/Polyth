// A short form the agent needs filled in. Values stay local until the user
// presses the block's button, which sends one line: "Title — Label: value; …".
import { useId } from "react";
import { fieldError, type ChatBlockDoc, type FormField } from "../src/parse.ts";
import { Select, Switch, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { BlockHead } from "./shared.tsx";
import type { ChatBlockStrings } from "./strings.ts";

export function fieldValue(field: FormField, values: Readonly<Record<string, string>>): string {
  return values[field.name] ?? field.value;
}

function fieldsWith(doc: ChatBlockDoc, values: Readonly<Record<string, string>>, error: "missing" | "invalid"): string[] {
  return doc.items.flatMap((item) => (item.field && fieldError(item.field, fieldValue(item.field, values)) === error ? [item.field.label] : []));
}

/** Required fields that are still empty. */
export function missingFields(doc: ChatBlockDoc, values: Readonly<Record<string, string>>): string[] {
  return fieldsWith(doc, values, "missing");
}

/** Filled fields whose value breaks the field's type, range or pattern. */
export function invalidFields(doc: ChatBlockDoc, values: Readonly<Record<string, string>>): string[] {
  return fieldsWith(doc, values, "invalid");
}

const INPUT_TYPES: Readonly<Partial<Record<FormField["type"], string>>> = { number: "number", date: "date", email: "email", url: "url" };

export default function FormView({ doc, t, values, setValue, locked, invalid = [] }: {
  doc: ChatBlockDoc;
  t: ChatBlockStrings;
  values: Readonly<Record<string, string>>;
  setValue(name: string, value: string): void;
  locked: boolean;
  /** Labels of fields whose current value cannot be sent. */
  invalid?: readonly string[];
}) {
  const base = useId();
  return (
    <>
      <BlockHead title={doc.title} />
      <div className="chat-block-form">
        {doc.items.map((item) => {
          const field = item.field;
          if (!field) return null;
          const id = `${base}-${item.index}`;
          const value = fieldValue(field, values);
          const bad = !locked && invalid.includes(field.label);
          const label = (
            <label className="chat-block-field-label" htmlFor={id} id={`${id}-label`}>
              {field.label}
              {field.required && <span className="chat-block-required" aria-label={t.required}> *</span>}
            </label>
          );
          if (field.type === "toggle") {
            return (
              <div key={item.index} className="chat-block-field is-toggle">
                <span className="chat-block-field-label" id={`${id}-label`}>{field.label}</span>
                <Switch checked={value === "true"} labelledBy={`${id}-label`} disabled={locked} onChange={(checked) => setValue(field.name, checked ? "true" : "false")} />
              </div>
            );
          }
          return (
            <div key={item.index} className={`chat-block-field is-${field.type}${bad ? " is-invalid" : ""}`}>
              {label}
              {field.type === "select" ? (
                <Select
                  label={field.label}
                  ariaLabel={field.label}
                  value={value || undefined}
                  placeholder={t.choose}
                  options={field.options.map((option) => ({ value: option, label: option }))}
                  disabled={locked}
                  onChange={(next) => setValue(field.name, next)}
                />
              ) : field.type === "textarea" ? (
                <Textarea
                  id={id}
                  value={value}
                  rows={3}
                  disabled={locked}
                  required={field.required}
                  invalid={bad}
                  onChange={(event) => setValue(field.name, event.target.value)}
                />
              ) : (
                <TextInput
                  id={id}
                  type={INPUT_TYPES[field.type] ?? "text"}
                  inputMode={field.type === "number" ? "decimal" : undefined}
                  min={field.min}
                  max={field.max}
                  value={value}
                  disabled={locked}
                  required={field.required}
                  invalid={bad}
                  onChange={(event) => setValue(field.name, event.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
