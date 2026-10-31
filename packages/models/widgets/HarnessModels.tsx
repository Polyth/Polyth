// Settings → Harnesses → harness → Models: which of this harness's models the
// account's model picker offers. A provider switch is a bulk change over its
// models; single models stay switchable either way, so a provider can go off
// and a search can bring back just the few that are needed. Presentation only
// — a hidden model keeps working for conversations, presets and agents that
// already use it.
import { useMemo, useState } from "react";
import type { HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";
import { hiddenModelMatcher, modelKey, orderProviders, providerPreferenceKey } from "@polyth/models";
import { tr } from "@polyth/web/i18n";
import { Button, ChevronRightIcon, Icon, SearchIcon, Switch, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import ProviderLogo from "./ProviderLogo.tsx";
import { modelContextLabel, providerLabel } from "./modelPresentation.ts";
import { pickerCatalogModels } from "./modelPickerState.ts";
import { setModelProviderHidden, setPickerModelsHidden, showAllHarnessModels, useModelPrefs } from "./modelPrefs.ts";

/** Rows rendered per provider before "Show more": a 400-model provider stays
 *  one calm screen until someone asks for the rest or searches. */
const PAGE = 40;
/** Small catalogs open fully; large ones start collapsed to their headers. */
const OPEN_BY_DEFAULT = 16;
const SEARCH_FROM = 9;

type ProviderGroup = { id: string; name: string; models: ModelDescriptor[] };

export default function HarnessModels({ harnessId, snapshot }: { harnessId: string; snapshot?: HarnessSnapshot }) {
  const prefs = useModelPrefs();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Readonly<Record<string, boolean>>>({});
  const [pages, setPages] = useState<Readonly<Record<string, number>>>({});
  const models = useMemo(() => pickerCatalogModels(snapshot?.catalog?.models ?? [], harnessId), [snapshot?.catalog?.models, harnessId]);
  const catalog = useMemo(() => models.map((model) => modelKey({ ...model, harnessId })), [models, harnessId]);
  const isHidden = useMemo(() => hiddenModelMatcher(prefs), [prefs]);
  const hiddenProviders = useMemo(() => new Set(prefs.hiddenProviders), [prefs.hiddenProviders]);
  const providers = useMemo(() => {
    const byId = new Map<string, ProviderGroup>();
    for (const model of models) {
      const group = byId.get(model.providerID) ?? { id: model.providerID, name: providerLabel(model.providerID, model.providerName), models: [] };
      group.models.push(model);
      byId.set(model.providerID, group);
    }
    return orderProviders([...byId.values()], prefs, harnessId);
  }, [models, prefs, harnessId]);
  const q = query.trim().toLowerCase();
  const matches = (model: ModelDescriptor) => !q || [model.name, model.modelID, model.providerName ?? "", model.providerID].join("\n").toLowerCase().includes(q);
  const shownCount = models.filter((model) => !isHidden(model, harnessId)).length;
  const anyHidden = shownCount < models.length;

  if (models.length === 0) {
    return <div className="models-visibility">
      <Section title={tr("harnessmodels.title")} hint={tr("harnessmodels.hint")}>
        <EmptyState compact icon="database" title={tr("harnessmodels.emptyTitle")} body={tr("harnessmodels.emptyBody")} />
      </Section>
    </div>;
  }

  const providerOff = (group: ProviderGroup) => hiddenProviders.has(providerPreferenceKey(harnessId, group.id));
  const row = (model: ModelDescriptor) => {
    const key = modelKey({ ...model, harnessId });
    const hidden = isHidden(model, harnessId);
    const id = model.modelID !== model.name ? model.modelID : "";
    const meta = [model.context ? modelContextLabel(model.context) : "", model.connected === false ? tr("modelpicker.notConnected") : ""].filter(Boolean);
    return <li key={key} className="models-visibility-model" data-hidden={hidden ? "true" : undefined}>
      <span className="models-visibility-model-copy">
        <span className="models-visibility-model-name">{model.name}</span>
        {(id || meta.length > 0) && <small>{id && <code>{id}</code>}{meta.map((part, index) => <span key={index}>{part}</span>)}</small>}
      </span>
      <Switch label={tr("harnessmodels.modelSwitch", { name: model.name })} checked={!hidden} onChange={(on) => setPickerModelsHidden([key], !on, catalog)} />
    </li>;
  };
  const list = (group: ProviderGroup, rows: ModelDescriptor[]) => {
    const limit = q ? rows.length : pages[group.id] ?? PAGE;
    const rest = rows.length - limit;
    return <>
      <ul className="models-visibility-list">{rows.slice(0, limit).map(row)}</ul>
      {rest > 0 && <Button size="sm" variant="ghost" className="models-visibility-more" onClick={() => setPages((current) => ({ ...current, [group.id]: limit + PAGE * 5 }))}>{tr("harnessmodels.showMore", { count: rest })}</Button>}
    </>;
  };

  const single = providers.length === 1 ? providers[0]! : undefined;
  const visibleGroups = providers.map((group) => ({ group, rows: group.models.filter(matches) })).filter((entry) => !q || entry.rows.length > 0);
  return <div className="models-visibility">
    <Section title={tr("harnessmodels.title")} hint={tr("harnessmodels.hint")}
      {...(anyHidden ? { action: <Button size="sm" variant="ghost" onClick={() => showAllHarnessModels(harnessId)}>{tr("harnessmodels.showAll")}</Button> } : {})}>
      <div className="models-visibility-toolbar">
        {models.length >= SEARCH_FROM && <label className="models-visibility-search">
          <Icon icon={SearchIcon} size="sm" />
          <TextInput uiSize="sm" type="search" value={query} placeholder={tr("harnessmodels.search")} aria-label={tr("harnessmodels.search")} autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        </label>}
        <span className="models-visibility-count" role="status">{tr("harnessmodels.count", { shown: shownCount, total: models.length })}</span>
      </div>
      {single
        ? <div className="models-visibility-group" data-single="true">{list(single, single.models.filter(matches))}</div>
        : visibleGroups.map(({ group, rows }) => {
          const off = providerOff(group);
          const expanded = q ? true : open[group.id] ?? group.models.length <= OPEN_BY_DEFAULT;
          const shown = group.models.filter((model) => !isHidden(model, harnessId)).length;
          return <section key={group.id} className="models-visibility-group" data-hidden={shown === 0 ? "true" : undefined} aria-label={group.name}>
            <div className="models-visibility-provider">
              <button type="button" className="models-visibility-expand" aria-expanded={expanded} disabled={Boolean(q)} onClick={() => setOpen((current) => ({ ...current, [group.id]: !expanded }))}>
                <Icon icon={ChevronRightIcon} size="sm" className="models-visibility-chevron" />
                <ProviderLogo providerID={group.id} providerName={group.name} size="compact" />
                <span className="models-visibility-provider-copy">
                  <strong>{group.name}</strong>
                  <small>{tr("harnessmodels.count", { shown, total: group.models.length })}</small>
                </span>
              </button>
              <Switch label={tr("harnessmodels.providerSwitch", { name: group.name })} checked={!off} onChange={(on) => setModelProviderHidden(harnessId, group.id, !on)} />
            </div>
            {expanded && list(group, rows)}
          </section>;
        })}
      {q && visibleGroups.every(({ rows }) => rows.length === 0) && <p className="models-visibility-empty" role="status">{tr("harnessmodels.noMatches", { query: query.trim() })}</p>}
    </Section>
  </div>;
}
