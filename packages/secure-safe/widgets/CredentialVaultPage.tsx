import { useEffect, useState, type FormEvent } from "react";
import type { SecureSafeEntryDto, SecureSafePartition } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, ErrorState, FormField, PageHead, Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import { vaultApi, type VaultAccess } from "./vaultApi.ts";

// Mirrors the server's handle rule so the form can explain it before submit.
const HANDLE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

interface Editing {
  entry: SecureSafeEntryDto;
  partition: SecureSafePartition;
}

export default function CredentialVaultPage() {
  const [entries, setEntries] = useState<SecureSafeEntryDto[]>([]);
  const [personal, setPersonal] = useState<SecureSafeEntryDto[]>([]);
  const [access, setAccess] = useState<VaultAccess>({ canManageSpace: false, personal: false });
  const [target, setTarget] = useState<SecureSafePartition>("personal");
  const [loading, setLoading] = useState(true);
  const [handle, setHandle] = useState("");
  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      // Older servers have no access route: they only know Space entries.
      const allowed = await vaultApi.access().catch(() => ({ canManageSpace: true, personal: false }));
      const [space, own] = await Promise.all([
        api.listSecureSafe(),
        allowed.personal ? vaultApi.listPersonal() : Promise.resolve([]),
      ]);
      setAccess(allowed);
      setTarget((current) => (allowed.personal ? (allowed.canManageSpace ? current : "personal") : "space"));
      setEntries(space);
      setPersonal(own);
      setLoadError("");
    } catch {
      setLoadError(tr("settings.securesafepage.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const resetForm = () => {
    setEditing(null);
    setHandle("");
    setLabel("");
    setPurpose("");
    setValue("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!handle.trim() || !label.trim() || (!editing && !value) || busy) return;
    const writeOnlyValue = value;
    setValue("");
    setBusy(true);
    setError("");
    try {
      if (editing) {
        const patch = {
          handle: handle.trim(),
          label: label.trim(),
          purpose: purpose.trim(),
          ...(writeOnlyValue ? { value: writeOnlyValue } : {}),
        };
        if (editing.partition === "personal") await vaultApi.updatePersonal(editing.entry.id, patch);
        else await api.updateSecureSafe(editing.entry.id, patch);
      } else {
        const input = {
          handle: handle.trim(),
          label: label.trim(),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
          value: writeOnlyValue,
        };
        if (target === "personal") await vaultApi.savePersonal(input);
        else await api.saveSecureSafe(input);
      }
      resetForm();
      await refresh();
    } catch {
      setError(tr("settings.securesafepage.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const edit = (entry: SecureSafeEntryDto, partition: SecureSafePartition) => {
    setEditing({ entry, partition });
    setHandle(entry.handle);
    setLabel(entry.label);
    setPurpose(entry.purpose);
    setValue("");
    setError("");
  };

  const remove = async (entry: SecureSafeEntryDto, partition: SecureSafePartition) => {
    if (!await confirmAlert(tr("settings.securesafepage.deleteTheSecureSafeHandleValue", { handle: entry.handle }), { title: tr("settings.securesafepage.deleteSecureSafeHandle"), confirmLabel: tr("common.delete") })) return;
    setError("");
    try {
      if (partition === "personal") {
        await vaultApi.deletePersonal(entry.id);
        setPersonal((current) => current.filter((item) => item.id !== entry.id));
      } else {
        await api.deleteSecureSafe(entry.id);
        setEntries((current) => current.filter((item) => item.id !== entry.id));
      }
    } catch {
      setLoadError(tr("settings.securesafepage.deleteFailed"));
    }
  };

  const handleInvalid = handle.trim() !== "" && !HANDLE_PATTERN.test(handle.trim());
  // Nothing to add to when a member has no personal partition (no signed-in
  // person) and may not change the Space's.
  const canAdd = access.personal || access.canManageSpace;
  const canSubmit = !busy && label.trim() !== "" && handle.trim() !== "" && !handleInvalid && (editing !== null || value !== "");

  const entryRows = (rows: SecureSafeEntryDto[], partition: SecureSafePartition, editable: boolean) => rows.map((entry) => (
    <Row
      key={entry.handle}
      label={entry.label}
      hint={<>
        <span className="credential-vault-handle mono">{entry.handle}</span>
        {entry.purpose && <span className="credential-vault-purpose">{entry.purpose}</span>}
      </>}
    >
      {editable && <>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(entry, partition)}>{tr("common.edit")}</Button>
        <Button size="sm" variant="ghost" className="credential-vault-delete" disabled={busy} onClick={() => void remove(entry, partition)}>{tr("common.delete")}</Button>
      </>}
    </Row>
  ));

  return (
    <div className="pkg-credential-vault">
      <PageHead
        title={tr("settings.securesafepage.secureSafe")}
        blurb={tr("settings.securesafepage.storeCredentialsBehindReusableHandlesValuesAre")}
      />
      {loading && entries.length === 0 && personal.length === 0 && <EmptyState compact busy title={tr("settings.securesafepage.loadingHandles")} />}
      {!loading && loadError && <ErrorState compact error={loadError} onRetry={() => void refresh()} />}
      {access.personal && (
        <Section
          title={tr("settings.securesafepage.yourCredentials")}
          hint={tr("settings.securesafepage.yourCredentialsHint")}
          itemId="credential-vault.personal"
        >
          {!loading && personal.length === 0 && !loadError && (
            <EmptyState
              compact
              icon="lock"
              title={tr("settings.securesafepage.noPersonalHandles")}
              body={tr("settings.securesafepage.addACredentialBelowOrRespondToAn")}
            />
          )}
          {entryRows(personal, "personal", true)}
        </Section>
      )}
      <Section
        title={access.personal ? tr("settings.securesafepage.spaceCredentials") : tr("settings.securesafepage.savedHandles")}
        hint={[
          access.personal ? tr(access.canManageSpace ? "settings.securesafepage.spaceCredentialsHint" : "settings.securesafepage.spaceCredentialsReadOnly") : "",
          entries.length > 0 ? tr("settings.securesafepage.savedHandlesCount", { count: formatNumber(entries.length) }) : "",
        ].filter(Boolean).join(" · ") || undefined}
        itemId="credential-vault.entries"
      >
        {!loading && entries.length === 0 && !loadError && (
          <EmptyState
            compact
            icon="lock"
            title={tr("settings.securesafepage.noSavedHandles")}
            {...(access.canManageSpace ? { body: tr("settings.securesafepage.addACredentialBelowOrRespondToAn") } : {})}
          />
        )}
        {entryRows(entries, "space", access.canManageSpace)}
      </Section>
      {(canAdd || editing) && <Section
        title={editing ? tr("settings.securesafepage.editCredential", { label: editing.entry.label }) : tr("settings.securesafepage.addCredential")}
        hint={tr("settings.securesafepage.securityNote")}
      >
        <form className="credential-vault-form" onSubmit={(event) => void save(event)}>
          {!editing && access.personal && access.canManageSpace && (
            <div className="settings-field">
              <span className="settings-field-label" aria-hidden="true">{tr("settings.securesafepage.saveTo")}</span>
              <Select
                label={tr("settings.securesafepage.saveTo")}
                value={target}
                options={[
                  { value: "personal", label: tr("settings.securesafepage.saveToMe") },
                  { value: "space", label: tr("settings.securesafepage.saveToSpace") },
                ]}
                onChange={(next) => setTarget(next === "space" ? "space" : "personal")}
              />
            </div>
          )}
          <div className="credential-vault-form-row">
            <FormField label={tr("settings.securesafepage.label")} hint={tr("settings.securesafepage.labelHint")}>
              {(field) => (
                <TextInput {...field} value={label} required placeholder={tr("settings.securesafepage.deploymentToken")} onChange={(event) => setLabel(event.target.value)} />
              )}
            </FormField>
            <FormField
              label={tr("settings.securesafepage.handle")}
              hint={tr("settings.securesafepage.handleHint")}
              {...(handleInvalid ? { error: tr("settings.securesafepage.handleInvalid") } : {})}
            >
              {(field) => (
                <TextInput
                  {...field}
                  className="mono"
                  value={handle}
                  required
                  placeholder={tr("settings.securesafepage.deployToken")}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setHandle(event.target.value)}
                />
              )}
            </FormField>
          </div>
          <FormField label={tr("settings.securesafepage.purpose")} hint={tr("settings.securesafepage.purposeHint")} optional>
            {(field) => (
              <TextInput {...field} value={purpose} placeholder={tr("settings.securesafepage.usedForProductionDeployments")} onChange={(event) => setPurpose(event.target.value)} />
            )}
          </FormField>
          <FormField
            label={tr("settings.securesafepage.credentialValue")}
            hint={editing ? tr("settings.securesafepage.leaveBlankToKeepCurrentValue") : tr("settings.securesafepage.theValueIsClearedAsSoonAs")}
          >
            {(field) => (
              <TextInput
                {...field}
                type="password"
                autoComplete="off"
                value={value}
                required={!editing}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </FormField>
          {error && <div className="credential-vault-status" role="alert">{error}</div>}
          <div className="credential-vault-form-actions">
            {editing && <Button size="sm" variant="ghost" onClick={resetForm}>{tr("common.cancel")}</Button>}
            <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!canSubmit}>
              {editing ? tr("common.save") : tr("settings.securesafepage.addToSecureSafe")}
            </Button>
          </div>
        </form>
      </Section>}
    </div>
  );
}
