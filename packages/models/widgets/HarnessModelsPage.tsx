import { useEffect, useMemo, useRef, useState } from "react";
import type { HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";
import { isFavorite, modelKey } from "@polyth/models";
import { createApiTransport } from "@polyth/web-sdk";
import { setModels, useStore } from "../../../apps/web/src/store.ts";
import { modelDisplayName } from "../../../apps/web/src/composer/discovery.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  FavoriteIcon,
  IconButton,
  Notice,
  RefreshIcon,
  Spinner,
  Switch,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import ProviderLogo from "./ProviderLogo.tsx";
import {
  readHarnessSnapshots,
  invalidateRuntimeCatalogs,
} from "./runtimeCatalog.ts";
import {
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "./modelPrefs.ts";

export const HARNESS_MODEL_SETTINGS_MIN_MODELS = 11;

interface HarnessVisibilityDto {
  ok?: boolean;
  disabledProviders: string[];
  disabledModels: string[];
}

interface ProviderGroup {
  id: string;
  name: string;
  models: ModelDescriptor[];
}

const api = createApiTransport();

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  "command-code": "Command Code",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  google: "Google",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  qwen: "Qwen",
  zai: "Z.AI",
};

const providerDisplayName = (id: string, name?: string): string =>
  name?.trim()
  || PROVIDER_NAMES[id.toLowerCase()]
  || id.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

const modelVisibilityKey = (model: ModelDescriptor): string =>
  `${model.providerID}/${model.modelID}`;

function providerGroups(models: readonly ModelDescriptor[]): ProviderGroup[] {
  const byId = new Map<string, ProviderGroup>();
  for (const model of models) {
    let group = byId.get(model.providerID);
    if (!group) {
      group = {
        id: model.providerID,
        name: providerDisplayName(model.providerID, model.providerName),
        models: [],
      };
      byId.set(model.providerID, group);
    } else if (group.name === group.id && model.providerName?.trim()) {
      group.name = model.providerName.trim();
    }
    group.models.push(model);
  }
  for (const group of byId.values()) {
    group.models.sort((a, b) =>
      (a.name || a.modelID).localeCompare(b.name || b.modelID));
  }
  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function fmtContext(context?: number): string {
  if (!context) return "";
  return context >= 1000 ? `${Math.round(context / 1000)}k ctx` : `${context} ctx`;
}

export default function HarnessModelsPage({
  harnessId,
  snapshot,
  projectId,
}: {
  harnessId: string;
  snapshot?: HarnessSnapshot;
  projectId?: string | null;
}) {
  const prefs = useModelPrefs();
  const globalModels = useStore((state) => state.models);
  const [models, setCatalogModels] = useState<ModelDescriptor[]>(
    () => snapshot?.catalog?.models ?? [],
  );
  const [visibility, setVisibility] = useState<HarnessVisibilityDto | null>(null);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState("");
  const busyRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const base = `/api/harnesses/${encodeURIComponent(harnessId)}`;
  const groups = useMemo(() => providerGroups(models), [models]);

  useEffect(() => {
    setCatalogModels(snapshot?.catalog?.models ?? []);
  }, [harnessId, snapshot]);

  useEffect(() => {
    let active = true;
    setVisibility(null);
    setError("");
    void api.get<HarnessVisibilityDto>(`${base}/model-visibility`)
      .then((state) => { if (active) setVisibility(state); })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [base]);

  const providerEnabled = (providerID: string, state = visibility): boolean =>
    !state?.disabledProviders.includes(providerID);

  const modelEnabled = (model: ModelDescriptor, state = visibility): boolean =>
    providerEnabled(model.providerID, state)
    && !state?.disabledModels.includes(modelVisibilityKey(model));

  const publish = (next: HarnessVisibilityDto) => {
    setVisibility(next);
    const enabled = models
      .filter((model) => modelEnabled(model, next))
      .map((model) => ({ ...model, harnessId }));
    const other = globalModels.filter((model) => model.harnessId !== harnessId);
    setModels([...other, ...enabled]);
    invalidateRuntimeCatalogs();
  };

  const mutate = async (
    key: string,
    optimistic: (state: HarnessVisibilityDto) => HarnessVisibilityDto,
    run: () => Promise<HarnessVisibilityDto>,
  ) => {
    if (!visibility || busyRef.current) return;
    const before = visibility;
    busyRef.current = true;
    setBusyKey(key);
    setError("");
    setVisibility(optimistic(before));
    try {
      publish(await run());
    } catch (cause) {
      setVisibility(before);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusyKey("");
    }
  };

  const toggleProvider = (providerID: string, enabled: boolean) => void mutate(
    `provider:${providerID}`,
    (state) => ({
      ...state,
      disabledProviders: enabled
        ? state.disabledProviders.filter((id) => id !== providerID)
        : [...new Set([...state.disabledProviders, providerID])],
    }),
    () => api.post<HarnessVisibilityDto>(
      `${base}/providers/${encodeURIComponent(providerID)}/enabled`,
      { enabled },
    ),
  );

  const toggleModel = (model: ModelDescriptor, enabled: boolean) => {
    const key = modelVisibilityKey(model);
    void mutate(
      `model:${key}`,
      (state) => ({
        ...state,
        disabledModels: enabled
          ? state.disabledModels.filter((item) => item !== key)
          : [...new Set([...state.disabledModels, key])],
      }),
      () => api.post<HarnessVisibilityDto>(`${base}/models/enabled`, { key, enabled }),
    );
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      const [rows, state] = await Promise.all([
        readHarnessSnapshots({
          projectId,
          harnessId,
          detail: true,
          force: true,
          allModels: true,
        }),
        api.get<HarnessVisibilityDto>(`${base}/model-visibility`),
      ]);
      setCatalogModels(rows[0]?.catalog?.models ?? []);
      setVisibility(state);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  if (!visibility && !error) {
    return <div className="models-page"><p className="models-loading" role="status">
      <Spinner label={tr("settings.modelspage.loadingCatalog")} />
      {tr("settings.modelspage.loadingCatalog")}
    </p></div>;
  }

  return <div className="models-page harness-models-page">
    <div className="models-toolbar">
      <IconButton
        className="models-refresh"
        icon={RefreshIcon}
        size="sm"
        label={tr("common.refresh")}
        busy={refreshing}
        disabled={refreshing}
        onClick={() => void refresh()}
      />
    </div>

    {error && <div className="form-error" role="alert">{error}</div>}
    {visibility && models.length === 0 && <Notice>{tr("settings.modelspage.noModelsYet")}</Notice>}

    <div className="provider-list">
      {visibility && groups.map((provider) => {
        const on = providerEnabled(provider.id);
        const enabledCount = provider.models.filter((model) => modelEnabled(model)).length;
        const expansionKey = `${harnessId}::${provider.id}`;
        const open = prefs.expandedProviders.includes(expansionKey);
        const query = queries[provider.id] ?? "";
        const normalized = query.trim().toLowerCase();
        const shown = normalized
          ? provider.models.filter((model) =>
              [model.name, model.modelID, model.providerName]
                .filter((value): value is string => typeof value === "string")
                .some((value) => value.toLowerCase().includes(normalized)))
          : provider.models;

        return <div key={provider.id} className={`provider-card ${on ? "" : "provider-disabled"}`}>
          <div className="provider-head">
            <button
              className="provider-expand"
              aria-expanded={open}
              aria-label={open
                ? tr("settings.modelspage.collapseValue", { value: provider.name })
                : tr("settings.modelspage.expandValue", { value: provider.name })}
              onClick={() => setModelProviderExpanded(expansionKey, !open)}
            >
              <span className={`provider-chevron ${open ? "open" : ""}`} aria-hidden="true">›</span>
              <ProviderLogo providerID={provider.id} providerName={provider.name} className="set-provider-logo" />
              <span className="provider-name">{provider.name}</span>
              <span className="provider-count mono">{enabledCount}/{provider.models.length}</span>
            </button>
            <Toggle
              on={on}
              label={tr("settings.modelspage.valueProviderValue", {
                value: on ? tr("settings.pages.disable") : tr("settings.pages.enable"),
                name: provider.name,
              })}
              onChange={(enabled) => toggleProvider(provider.id, enabled)}
            />
          </div>

          {open && <div className="provider-models">
            {provider.models.length >= 6 && <TextInput
              className="provider-model-filter"
              value={query}
              placeholder={tr("settings.modelspage.filterProviderModels", { name: provider.name })}
              aria-label={tr("settings.modelspage.filterProviderModels", { name: provider.name })}
              onChange={(event) => setQueries((current) => ({
                ...current,
                [provider.id]: event.target.value,
              }))}
            />}
            {normalized && shown.length === 0 && <p className="provider-empty-models">
              {tr("settings.modelspage.noMatches")}
            </p>}
            {shown.map((model) => {
              const enabled = modelEnabled(model);
              const favoriteKey = modelKey({ ...model, harnessId });
              const favorite = isFavorite(prefs, favoriteKey);
              const displayName = modelDisplayName(model, provider.models);
              const key = modelVisibilityKey(model);
              return <div key={key} className={`set-model-row ${enabled ? "" : "model-disabled"}`}>
                <IconButton
                  icon={FavoriteIcon}
                  size="sm"
                  variant="ghost"
                  className={`model-star-btn ${favorite ? "on" : ""}`}
                  pressed={favorite}
                  label={favorite
                    ? tr("settings.modelspage.removeFavorite")
                    : tr("settings.modelspage.addFavorite")}
                  onClick={() => toggleModelFavorite(favoriteKey)}
                />
                <span className="set-model-name" title={displayName}>{displayName}</span>
                {model.context !== undefined && <span className="set-model-ctx mono">{fmtContext(model.context)}</span>}
                <span className="set-model-meta mono">{model.modelID}</span>
                <Switch
                  checked={enabled}
                  label={!on
                    ? tr("settings.modelspage.enableTheProviderFirst")
                    : enabled
                      ? tr("settings.modelspage.disableValue", { value: displayName })
                      : tr("settings.modelspage.enableValue", { value: displayName })}
                  disabled={busyKey === `model:${key}` || Boolean(busyKey) || !on}
                  onChange={(value) => toggleModel(model, value)}
                />
              </div>;
            })}
          </div>}
        </div>;
      })}
    </div>
  </div>;
}
