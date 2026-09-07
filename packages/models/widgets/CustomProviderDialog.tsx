import { useMemo, useState } from "react";
import type { CustomProviderProtocol } from "@polyth/contracts";
import { isFavorite, slugifyProviderId } from "@polyth/models";
import { api } from "@polyth/session/web-api";
import { Button, CloseIcon, Dialog, IconButton, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { getModelPrefs, toggleModelFavorite } from "./modelPrefs.ts";

export interface CustomProviderDialogValues {
  id?: string;
  name: string;
  baseURL: string;
  protocol: CustomProviderProtocol;
  authMode: "api-key" | "none";
  headerNames?: string[];
  modelIDs?: string[];
  readOnly?: boolean;
}

interface HeaderRow {
  key: string;
  name: string;
  value: string;
  existing: boolean;
}

let headerRowSeq = 0;

export default function CustomProviderDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing?: CustomProviderDialogValues;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const editing = Boolean(existing?.id);
  const readOnly = existing?.readOnly === true;
  const [name, setName] = useState(existing?.name ?? "");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [protocol, setProtocol] = useState<CustomProviderProtocol>(existing?.protocol ?? "openai-compatible");
  const [authMode, setAuthMode] = useState<"api-key" | "none">(existing?.authMode ?? "api-key");
  const [apiKey, setApiKey] = useState("");
  const [idEdited, setIdEdited] = useState(Boolean(existing?.id));
  const [id, setId] = useState(existing?.id ?? "");
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    (existing?.headerNames ?? []).map((headerName) => ({
      key: `h${headerRowSeq += 1}`,
      name: headerName,
      value: "",
      existing: true,
    })),
  );
  const [clearedHeaders, setClearedHeaders] = useState(false);
  const [advanced, setAdvanced] = useState((existing?.headerNames?.length ?? 0) > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discoverMessage, setDiscoverMessage] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [configuredModels, setConfiguredModels] = useState<string[]>(() => existing?.modelIDs ?? []);

  const derivedId = useMemo(() => slugifyProviderId(name), [name]);
  const shownId = idEdited ? id : derivedId;

  const headerPatch = () => {
    const original = new Set(existing?.headerNames ?? []);
    const set: Record<string, string> = {};
    const kept = new Set<string>();
    for (const row of headers) {
      const headerName = row.name.trim();
      if (!headerName) continue;
      kept.add(headerName);
      if (row.value.trim()) set[headerName] = row.value;
    }
    const unset = [...original].filter((headerName) => !kept.has(headerName));
    if (clearedHeaders && Object.keys(set).length === 0 && unset.length === original.size) {
      return { clear: true as const };
    }
    if (Object.keys(set).length === 0 && unset.length === 0) return undefined;
    return {
      ...(Object.keys(set).length ? { set } : {}),
      ...(unset.length ? { unset } : {}),
    };
  };

  const save = async () => {
    if (readOnly) return;
    setBusy(true);
    setError("");
    const patch = headerPatch();
    const payload = {
      name,
      baseURL,
      protocol,
      authMode,
      ...(!editing ? { id: shownId } : {}),
      ...(authMode === "api-key" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(patch ? { headerPatch: patch } : {}),
    };
    try {
      const result = editing && existing?.id
        ? await api.updateCustomProvider(existing.id, payload)
        : await api.createCustomProvider(payload);
      onSaved(result.id);
      if (!editing) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const discover = async () => {
    if (!existing?.id) return;
    if (authMode === "api-key" && !apiKey.trim()) {
      setDiscoverMessage(tr("settings.modelspage.rediscoverNeedsKey"));
      return;
    }
    setBusy(true);
    setError("");
    setDiscoverMessage("");
    try {
      const result = await api.discoverCustomProviderModels(
        existing.id,
        authMode === "api-key" && apiKey.trim() ? apiKey.trim() : undefined,
      );
      if (result.unsupported) {
        setDiscoverMessage(result.message ?? tr("settings.modelspage.noModelsYet"));
      } else {
        setDiscoverMessage(tr("settings.modelspage.discoveredCount", { count: String(result.models.length) }));
        setConfiguredModels((prev) => [...new Set([...prev, ...result.models.map((model) => model.id)])]);
        onSaved(existing.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addManual = async () => {
    if (!existing?.id || !manualId.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.addCustomProviderModel(existing.id, {
        id: manualId.trim(),
        ...(manualName.trim() ? { name: manualName.trim() } : {}),
      });
      const added = manualId.trim();
      setManualId("");
      setManualName("");
      setConfiguredModels((prev) => prev.includes(added) ? prev : [...prev, added]);
      onSaved(existing.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (modelId: string) => {
    if (!existing?.id) return;
    setBusy(true);
    setError("");
    try {
      await api.removeCustomProviderModel(existing.id, modelId);
      const key = `${existing.id}/${modelId}`;
      if (isFavorite(getModelPrefs(), key)) toggleModelFavorite(key);
      setConfiguredModels((prev) => prev.filter((id) => id !== modelId));
      onSaved(existing.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={readOnly
        ? tr("settings.modelspage.configuredOutside")
        : editing
          ? tr("settings.modelspage.editProvider")
          : tr("settings.modelspage.customProvider")}
      onClose={onClose}
      size="md"
      className="custom-provider-dialog"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button>
          {!readOnly && (
            <Button
              variant="primary"
              busy={busy}
              disabled={busy || !name.trim() || !baseURL.trim() || (authMode === "api-key" && !editing && !apiKey.trim())}
              onClick={() => void save()}
            >
              {editing ? tr("settings.modelspage.saveProvider") : tr("settings.modelspage.createProvider")}
            </Button>
          )}
        </>
      )}
    >
      <div className="custom-provider-form">
        <label className="custom-provider-field">
          <span>{tr("settings.modelspage.displayName")}</span>
          <TextInput value={name} autoFocus disabled={readOnly} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="custom-provider-field">
          <span>{tr("settings.modelspage.baseUrl")}</span>
          <TextInput
            value={baseURL}
            placeholder="http://127.0.0.1:1234/v1"
            disabled={readOnly}
            onChange={(e) => setBaseURL(e.target.value)}
          />
        </label>
        <Select
          label={tr("settings.modelspage.apiType")}
          value={protocol}
          disabled={readOnly}
          onChange={(value) => setProtocol(value as CustomProviderProtocol)}
          options={[
            { value: "openai-compatible", label: tr("settings.modelspage.protocolCompletions") },
            { value: "openai-responses", label: tr("settings.modelspage.protocolResponses") },
          ]}
        />
        <Select
          label={tr("settings.modelspage.authMode")}
          value={authMode}
          disabled={readOnly}
          onChange={(value) => setAuthMode(value as "api-key" | "none")}
          options={[
            { value: "api-key", label: tr("settings.modelspage.authApiKey") },
            { value: "none", label: tr("settings.modelspage.authNone") },
          ]}
        />
        {authMode === "api-key" && !readOnly && (
          <label className="custom-provider-field">
            <span>{tr("settings.modelspage.apiKey")}</span>
            <TextInput
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={editing ? tr("settings.modelspage.secretUnchanged") : undefined}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
        )}
        <Button size="sm" variant="ghost" onClick={() => setAdvanced((v) => !v)}>
          {tr("settings.modelspage.advanced")}
        </Button>
        {advanced && (
          <>
            <label className="custom-provider-field">
              <span>{tr("settings.modelspage.providerId")}</span>
              <TextInput
                value={shownId}
                disabled={editing || readOnly}
                onChange={(e) => {
                  setIdEdited(true);
                  setId(e.target.value);
                }}
              />
            </label>
            <div className="custom-provider-headers">
              <span>{tr("settings.modelspage.customHeaders")}</span>
              <p className="custom-provider-readonly">{tr("settings.modelspage.customHeadersHint")}</p>
              {headers.map((row) => (
                <div key={row.key} className="custom-provider-header-row">
                  <TextInput
                    aria-label={tr("settings.modelspage.headerName")}
                    placeholder={tr("settings.modelspage.headerName")}
                    value={row.name}
                    disabled={readOnly}
                    onChange={(e) => setHeaders((prev) =>
                      prev.map((item) => item.key === row.key ? { ...item, name: e.target.value } : item))}
                  />
                  <TextInput
                    type="password"
                    autoComplete="off"
                    aria-label={tr("settings.modelspage.headerValue")}
                    placeholder={row.existing
                      ? tr("settings.modelspage.secretUnchanged")
                      : tr("settings.modelspage.headerValue")}
                    value={row.value}
                    disabled={readOnly}
                    onChange={(e) => setHeaders((prev) =>
                      prev.map((item) => item.key === row.key ? { ...item, value: e.target.value } : item))}
                  />
                  {!readOnly && (
                    <IconButton
                      icon={CloseIcon}
                      size="sm"
                      variant="ghost"
                      label={tr("settings.modelspage.removeHeader")}
                      onClick={() => {
                        setHeaders((prev) => prev.filter((item) => item.key !== row.key));
                        if (row.existing) setClearedHeaders(false);
                      }}
                    />
                  )}
                </div>
              ))}
              {!readOnly && (
                <div className="custom-provider-header-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setHeaders((prev) => [
                      ...prev,
                      { key: `h${headerRowSeq += 1}`, name: "", value: "", existing: false },
                    ])}
                  >
                    {tr("settings.modelspage.addHeader")}
                  </Button>
                  {headers.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setHeaders([]);
                        setClearedHeaders(true);
                      }}
                    >
                      {tr("settings.modelspage.clearHeaders")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        {editing && !readOnly && (
          <div className="custom-provider-models">
            <span>{tr("settings.modelspage.configuredModels")}</span>
            <Button size="sm" variant="ghost" busy={busy} disabled={busy} onClick={() => void discover()}>
              {tr("settings.modelspage.discoverModels")}
            </Button>
            {authMode === "api-key" && (
              <p className="custom-provider-readonly">{tr("settings.modelspage.rediscoverNeedsKey")}</p>
            )}
            {discoverMessage && <p className="custom-provider-discover-msg">{discoverMessage}</p>}
            {configuredModels.length > 0 && (
              <ul className="custom-provider-model-list">
                {configuredModels.map((modelId) => (
                  <li key={modelId} className="custom-provider-model-row">
                    <span className="mono" title={modelId}>{modelId}</span>
                    <IconButton
                      icon={CloseIcon}
                      size="sm"
                      variant="ghost"
                      label={tr("settings.modelspage.removeModel")}
                      disabled={busy}
                      onClick={() => void removeModel(modelId)}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className="provider-manual-model">
              <TextInput
                placeholder={tr("settings.modelspage.modelId")}
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
              />
              <TextInput
                placeholder={tr("settings.modelspage.modelDisplayName")}
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
              />
              <Button size="sm" disabled={!manualId.trim() || busy} onClick={() => void addManual()}>
                {tr("settings.modelspage.addModel")}
              </Button>
            </div>
          </div>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        {readOnly && (
          <p className="custom-provider-readonly">{tr("settings.modelspage.configuredOutsideHint")}</p>
        )}
      </div>
    </Dialog>
  );
}
