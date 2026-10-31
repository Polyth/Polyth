import { useEffect, useState } from "react";
import type { PersonGitProfileDto } from "@polyth/contracts/source-control";
import { sessionFetch } from "@polyth/session/web-api";
import { Button, Notice, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { FormField, SaveBar, Section, type SaveStatusState } from "../../../apps/web/src/components/settings/parts.tsx";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  PERSON_GIT_PROFILE_PATH,
  setPersonGitProfile,
  usePersonGitProfile,
} from "./personGitProfile.ts";
import { PERSON_PROFILE_ITEM } from "./gitRefusal.ts";

type FieldErrors = { name?: string; email?: string; form?: string };

const failure = (cause: unknown): FieldErrors => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const field = (cause as { field?: unknown } | null)?.field;
  return field === "name" || field === "email" ? { [field]: message } : { form: message };
};

/** The signed-in person's own commit identity (Spaces §14.4): every commit
 *  Polyth makes for them carries it, in every Space. Stored with the person,
 *  never in a checkout's Git config. A draft form: Save applies both fields. */
export default function PersonGitProfileSection() {
  const state = usePersonGitProfile({ refresh: true });
  const dto = state.status === "ready" ? state.dto : null;
  const stored = { name: dto?.profile?.name ?? "", email: dto?.profile?.email ?? "" };
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<SaveStatusState>("idle");

  // Adopt the stored profile whenever it changes underneath the form.
  useEffect(() => {
    setName(stored.name);
    setEmail(stored.email);
  }, [stored.name, stored.email]);

  const write = async (kind: "save" | "clear", init: RequestInit) => {
    setBusy(kind);
    setErrors({});
    setStatus(kind === "save" ? "saving" : "idle");
    try {
      setPersonGitProfile(await sessionFetch<PersonGitProfileDto>(PERSON_GIT_PROFILE_PATH, init));
      setStatus(kind === "save" ? "saved" : "idle");
    } catch (cause) {
      setErrors(failure(cause));
      setStatus("idle");
    } finally {
      setBusy(null);
    }
  };
  const dirty = name.trim() !== stored.name || email.trim() !== stored.email;
  const complete = name.trim() !== "" && email.trim() !== "";
  const save = () => {
    if (!dto || busy || !dirty || !complete) return;
    void write("save", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), email: email.trim() }),
    });
  };
  const clear = async () => {
    const consequence = dto?.usesInstallationFallback ? tr("gitsettings.personRemoveFallback") : tr("gitsettings.personRemoveRefused");
    const confirmed = await confirmAlert(tr("gitsettings.personRemoveConfirm", { consequence }), {
      title: tr("gitsettings.personRemoveTitle"),
      confirmLabel: tr("gitsettings.personRemove"),
      destructive: true,
    });
    if (confirmed) await write("clear", { method: "DELETE" });
  };
  const edit = (apply: () => void) => { apply(); setStatus("idle"); };

  const hint = dto?.profile ? tr("gitsettings.personHintSet")
    : dto?.usesInstallationFallback ? tr("gitsettings.personHintFallback")
      : tr("gitsettings.personHintMissing");

  return (
    <Section
      title={tr("gitsettings.personTitle")}
      hint={hint}
      itemId={PERSON_PROFILE_ITEM}
      {...(dto?.profile ? {
        action: <Button type="button" size="sm" variant="ghost" busy={busy === "clear"} disabled={busy !== null} onClick={() => void clear()}>{tr("gitsettings.personRemove")}</Button>,
      } : {})}
    >
      {state.status === "unavailable" && <Notice tone="warning">{tr("gitsettings.personUnavailable", { error: state.error })}</Notice>}
      {dto && !dto.profile && !dto.usesInstallationFallback && (
        <Notice tone="warning" className="git-person-profile-notice">{tr("gitsettings.personRefused")}</Notice>
      )}
      <form
        className="source-control-person-profile"
        aria-busy={state.status === "loading" || undefined}
        onSubmit={(event) => { event.preventDefault(); save(); }}
      >
        <div className="source-control-person-profile-fields">
          <FormField label={tr("gitsettings.personName")} error={errors.name}>
            {(field) => <TextInput {...field} value={name} autoComplete="name" placeholder="Ada Lovelace" disabled={!dto || busy !== null} onChange={(event) => edit(() => setName(event.target.value))} />}
          </FormField>
          <FormField label={tr("gitsettings.personEmail")} error={errors.email}>
            {(field) => <TextInput {...field} type="email" inputMode="email" autoComplete="email" spellCheck={false} autoCapitalize="off" value={email} placeholder="ada@example.com" disabled={!dto || busy !== null} onChange={(event) => edit(() => setEmail(event.target.value))} />}
          </FormField>
        </div>
        {/* An Enter in either field submits. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <SaveBar
          dirty={dirty}
          canSave={complete}
          saving={busy === "save"}
          status={status}
          onSave={save}
          onDiscard={() => { setName(stored.name); setEmail(stored.email); setErrors({}); }}
        />
      </form>
      {errors.form && <Notice tone="error" role="alert">{errors.form}</Notice>}
    </Section>
  );
}
