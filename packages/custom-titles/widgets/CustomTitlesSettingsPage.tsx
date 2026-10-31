import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HarnessSelection, ModelRef } from "@polyth/contracts";
import ModelPicker from "@polyth/models/model-picker";
import { useOtherHarnessModels, useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import {
  DEFAULT_CUSTOM_TITLE_SETTINGS,
  parseCustomTitleSettings,
  type CustomTitleSettings,
} from "@polyth/custom-titles/settings";
import { ApiError, createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { EmptyState, ErrorState, FormField, PageHead, Row, SaveBar, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { useStore } from "../../../apps/web/src/store.ts";
import { customTitlesStrings } from "./strings.ts";

interface SettingsSnapshot {
  revision: number;
  settings: CustomTitleSettings;
}

const api = createApiTransport();

// The generator's default is not a concrete catalog row: the runtime picks the
// fastest available free OpenCode text model per title. It is the picker's
// leading empty row, the same way "Auto" works in the composer's siblings.
// A product/brand label, identical in every locale.
const FREE_MODEL_LABEL = customTitlesStrings("en").modelFree;

// Stored as free text the generator reads as an instruction; "auto" follows
// each request. A custom value saved earlier stays selectable.
const LANGUAGES = [
  "English", "Ukrainian", "German", "French", "Spanish", "Italian", "Portuguese",
  "Polish", "Bulgarian", "Arabic", "Chinese", "Japanese", "Korean",
];
/** Stored title-language names map to codes so each row is labelled in the UI
 *  locale while the saved free-text value stays what the generator reads. */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  English: "en", Ukrainian: "uk", German: "de", French: "fr", Spanish: "es",
  Italian: "it", Portuguese: "pt", Polish: "pl", Bulgarian: "bg", Arabic: "ar",
  Chinese: "zh", Japanese: "ja", Korean: "ko",
};
const languageLabel = (name: string, locale: string): string => {
  const code = LANGUAGE_CODES[name];
  if (!code) return name;
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? name;
  } catch {
    return name;
  }
};

export default function CustomTitlesSettingsPage({ host }: { host: WebPackageHost }) {
  const locale = host.ui.locale.get();
  const copy = customTitlesStrings(locale);
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<CustomTitleSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** Harness the picker is browsing. Null follows the saved generator route. */
  const [pickerHarness, setPickerHarness] = useState<HarnessSelection | null>(null);
  const projectId = useSyncExternalStore(
    host.store.subscribe,
    () => host.store.getSnapshot().activeProjectId,
    () => host.store.getSnapshot().activeProjectId,
  );
  const globalModels = useStore((state) => state.models);
  const globalAgents = useStore((state) => state.agents);
  const projects = useStore((state) => state.projectRegistry.projects);
  const spaceId = projects.find((project) => project.id === projectId)?.spaceId;
  const storedHarnessId = draft?.generator.kind === "custom" ? draft.generator.harnessId : undefined;
  const pickerHarnessId = pickerHarness?.mode === "pinned" ? pickerHarness.harnessId : storedHarnessId;
  // The composer's own catalog source, so the settings picker offers the same
  // harness tabs, provider groups, favorites and cross-harness search.
  const routeCatalog = useRuntimeCatalog(null, globalModels, globalAgents, {
    ...(projectId ? { projectId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(pickerHarnessId ? { harnessId: pickerHarnessId } : {}),
  });
  const catalogHarnessId = pickerHarnessId ?? routeCatalog.harnessId;
  const models = useMemo(
    () => catalogHarnessId
      ? routeCatalog.models.filter((model) => !model.harnessId || model.harnessId === catalogHarnessId)
      : routeCatalog.models,
    [routeCatalog.models, catalogHarnessId],
  );
  const otherHarnessModels = useOtherHarnessModels({
    ...(projectId ? { projectId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(catalogHarnessId ? { excludeHarnessId: catalogHarnessId } : {}),
  });

  useEffect(() => {
    mounted.current = true;
    void api.get<SettingsSnapshot>("/api/custom-titles/settings")
      .then((value) => {
        if (!mounted.current) return;
        const settings = parseCustomTitleSettings(value.settings);
        setSnapshot({ revision: value.revision, settings });
        setDraft(settings);
      })
      .catch((cause) => {
        if (mounted.current) setLoadError(cause ?? new Error(copy.unavailableError));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => { mounted.current = false; };
  }, []);

  const selectedModel = useMemo<ModelRef & { harnessId?: string } | undefined>(() => {
    if (draft?.generator.kind !== "custom") return undefined;
    return {
      harnessId: draft.generator.harnessId,
      providerID: draft.generator.providerID,
      modelID: draft.generator.modelID,
    };
  }, [draft]);

  const update = (patch: Partial<CustomTitleSettings>) => {
    setSaved(false);
    setDraft((current) => current ? { ...current, ...patch } : current);
  };

  const onPickModel = (model?: ModelRef & { harnessId?: string }) => {
    // The picker's leading row clears back to the free default; any concrete
    // model (including one found in another harness) pins its own route.
    setPickerHarness(null);
    if (!model) {
      update({ generator: { kind: "opencode-free" } });
      return;
    }
    update({
      generator: {
        kind: "custom",
        harnessId: model.harnessId ?? catalogHarnessId ?? "opencode",
        providerID: model.providerID,
        modelID: model.modelID,
      },
    });
  };

  const harnessSelection: HarnessSelection = pickerHarness
    ?? (storedHarnessId ? { mode: "pinned", harnessId: storedHarnessId } : { mode: "auto" });

  const save = async () => {
    if (!draft || !snapshot || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const parsed = parseCustomTitleSettings(draft);
      const result = await api.put<SettingsSnapshot>("/api/custom-titles/settings", {
        settings: parsed,
        expectedRevision: snapshot.revision,
      });
      if (!mounted.current) return;
      const settings = parseCustomTitleSettings(result.settings);
      setSnapshot({ revision: result.revision, settings });
      setDraft(settings);
      setSaved(true);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setError(copy.settingsChanged);
      } else {
        setError(host.errors.friendly(copy.saveFailed, cause));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const { Select, TextInput, Textarea } = host.ui.components;
  if (loading) {
    return (
      <section className="custom-titles-settings">
        <PageHead blurb={copy.pageBlurb} />
        <EmptyState title={copy.loading} busy />
      </section>
    );
  }
  if (!draft || !snapshot) {
    return (
      <section className="custom-titles-settings">
        <PageHead blurb={copy.pageBlurb} />
        <ErrorState
          title={copy.unavailableTitle}
          error={loadError ?? new Error(copy.unavailableRetry)}
        />
      </section>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.settings);
  const language = draft.language.trim() || "auto";
  const languageOptions = [
    { value: "auto", label: copy.languageAuto },
    ...LANGUAGES.map((name) => ({ value: name, label: languageLabel(name, locale) })),
    ...(language !== "auto" && !LANGUAGES.includes(language) ? [{ value: language, label: language }] : []),
  ];

  return (
    <section className="custom-titles-settings">
      <PageHead blurb={copy.pageBlurb} />

      <Section title={copy.sectionNaming}>
        <Row
          label={copy.itemModeLabel}
          hint={copy.modeHint}
          itemId="custom-titles.mode"
        >
          <Select
            label={copy.itemModeLabel}
            ariaLabel={copy.itemModeLabel}
            value={draft.mode}
            disabled={busy}
            options={[
              { value: "fallback", label: copy.modeFallback },
              { value: "always", label: copy.modeAlways },
            ]}
            onChange={(value: unknown) => update({ mode: String(value) as CustomTitleSettings["mode"] })}
          />
        </Row>

        <Row
          label={copy.modelLabel}
          hint={copy.modelHint}
          itemId="custom-titles.model"
        >
          <div className="custom-titles-settings__controls">
            <ModelPicker
              models={models}
              {...(catalogHarnessId ? { harnessId: catalogHarnessId } : {})}
              {...(selectedModel ? { value: selectedModel } : {})}
              emptyLabel={FREE_MODEL_LABEL}
              direction="down"
              catalogLoading={routeCatalog.discovery.state === "pending"}
              otherHarnesses={otherHarnessModels}
              header={<host.ui.Slot
                slot="modelPicker.header"
                context={{
                  ...(spaceId ? { spaceId } : {}),
                  ...(projectId ? { projectId } : {}),
                  harnessSelection,
                  ...(catalogHarnessId ? { resolvedHarnessId: catalogHarnessId } : {}),
                  pendingHarnessSelection: harnessSelection,
                  onSelectHarness: (selection: HarnessSelection) => setPickerHarness(selection),
                }}
              />}
              onPick={onPickModel}
              className="custom-titles-settings__model-picker"
            />
            {models.length === 0 && routeCatalog.discovery.state !== "pending" ? (
              <span className="custom-titles-settings__hint">{copy.modelEmpty}</span>
            ) : null}
          </div>
        </Row>
      </Section>

      <Section title={copy.sectionStyle} itemId="custom-titles.rules">
        <Row label={copy.languageLabel} hint={copy.languageHint}>
          <Select
            label={copy.languageLabel}
            ariaLabel={copy.languageAria}
            value={language}
            disabled={busy}
            options={languageOptions}
            onChange={(value: unknown) => update({ language: String(value) })}
          />
        </Row>

        <div className="custom-titles-settings__fields">
          <FormField label={copy.styleLabel} hint={copy.styleHint}>
            <TextInput
              value={draft.style}
              disabled={busy}
              placeholder={DEFAULT_CUSTOM_TITLE_SETTINGS.style}
              onChange={(event) => update({ style: event.target.value })}
            />
          </FormField>

          <FormField label={copy.rulesLabel} hint={copy.rulesHint} optional>
            <Textarea
              value={draft.rules}
              disabled={busy}
              rows={3}
              placeholder={copy.rulesPlaceholder}
              onChange={(event: { target: { value: string } }) => update({ rules: event.target.value })}
            />
          </FormField>
        </div>
      </Section>

      <SaveBar
        dirty={dirty}
        saving={busy}
        status={error ? "error" : saved ? "saved" : "idle"}
        {...(error ? { error } : {})}
        onSave={() => void save()}
        onDiscard={() => { setDraft(snapshot.settings); setError(null); }}
      />
    </section>
  );
}
