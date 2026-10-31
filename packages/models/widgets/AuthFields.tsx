import { useState } from "react";
import type { NormalizedAuthField } from "@polyth/contracts";
import {
  HideIcon,
  IconButton,
  Select,
  ShowIcon,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { defaultSelectValue, promptVisible, withSelectDefaults, type PromptValues } from "../src/auth/prompts.ts";

export default function AuthFields({
  fields,
  values,
  onChange,
  disabled,
  invalidKey,
}: {
  fields: readonly NormalizedAuthField[];
  values: PromptValues;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  invalidKey?: string;
}) {
  const visible = fields.filter((field) => promptVisible(field, withSelectDefaults(fields, values)));
  if (!visible.length) return null;
  return (
    <>
      {visible.map((field) => (
        <AuthField
          key={field.key}
          field={field}
          value={values[field.key] ?? defaultSelectValue(field) ?? ""}
          invalid={invalidKey === field.key}
          disabled={disabled}
          onChange={(value) => onChange(field.key, value)}
        />
      ))}
    </>
  );
}

function AuthField({
  field,
  value,
  onChange,
  disabled,
  invalid,
}: {
  field: NormalizedAuthField;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  if (field.kind === "select") {
    return (
      <label className="provider-auth-field">
        <span className="provider-auth-label">{field.label}</span>
        <Select
          label={field.label}
          value={value}
          options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
          onChange={onChange}
          placeholder={field.placeholder ?? field.label}
          disabled={disabled}
        />
      </label>
    );
  }
  if (field.kind === "boolean") {
    return (
      <label className="provider-auth-field provider-auth-check">
        <input
          type="checkbox"
          checked={value === "true"}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  const secret = field.secret || field.kind === "secret";
  const inputType = secret && !show
    ? "password"
    : field.kind === "email"
      ? "email"
      : field.kind === "url"
        ? "url"
        : "text";
  return (
    <label className="provider-auth-field">
      <span className="provider-auth-label">{field.label}</span>
      <span className="provider-auth-input-row">
        <TextInput
          type={inputType}
          value={value}
          invalid={invalid}
          disabled={disabled}
          placeholder={field.placeholder ?? field.label}
          autoComplete={field.autocomplete ?? (secret ? "off" : undefined)}
          spellCheck={false}
          aria-label={field.label}
          onChange={(event) => onChange(event.target.value)}
        />
        {secret && (
          <IconButton
            icon={show ? HideIcon : ShowIcon}
            size="sm"
            label={show ? tr("settings.modelspage.hideSecret") : tr("settings.modelspage.showSecret")}
            onClick={() => setShow((current) => !current)}
          />
        )}
      </span>
    </label>
  );
}
