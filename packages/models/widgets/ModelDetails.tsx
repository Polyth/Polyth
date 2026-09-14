import { useEffect, useRef, type ReactNode } from "react";
import type { ModelDescriptor } from "@polyth/contracts";
import {
  BackIcon,
  Button,
  FavoriteIcon,
} from "@polyth/web/ui";
import { Icon } from "@polyth/web/icons";
import { getLocale, tr } from "@polyth/web/i18n";
import ProviderLogo from "./ProviderLogo.tsx";
import {
  formatModelPrice,
  hasModelPricing,
  modelDetailsPresentation,
  modelSupportsThinking,
} from "./modelPresentation.ts";

/** Explicit phone details route. Desktop uses the compact hover card below. */
export function ModelDetails({
  model,
  selected,
  usage,
  onUse,
  onBack,
  focusBack = false,
}: {
  model: ModelDescriptor;
  selected: boolean;
  /** Current session input tokens — shown against this model's limit. */
  usage?: number;
  onUse: () => void;
  onBack: () => void;
  /** Phone details replace the list inside its modal sheet. */
  focusBack?: boolean;
}) {
  const detailsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusBack) detailsRef.current?.querySelector<HTMLButtonElement>(".model-details-back")?.focus();
  }, [focusBack]);
  const presentation = modelDetailsPresentation(model);
  const percent = selected && usage && model.context
    ? Math.min(100, Math.round((usage / model.context) * 100))
    : null;
  const rows: Array<[string, ReactNode]> = [
    [tr("modelpicker.provider"), presentation.provider],
    [tr("modelpicker.contextWindow"), presentation.context],
    [tr("modelpicker.modalities"), presentation.modalities],
    [tr("modelpicker.reasoning"), presentation.reasoning],
    [tr("modelpicker.toolCalls"), presentation.tools],
    ...(presentation.pricing
      ? [[tr("modelpicker.pricing"), presentation.pricing] as [string, ReactNode]]
      : []),
    ...(presentation.availability
      ? [[tr("modelpicker.availability"),
          <span key="na" className="model-details-warn">{presentation.availability}</span>] as [string, ReactNode]]
      : []),
    ...(percent !== null
      ? [[tr("modelpicker.contextUsed"),
          <span key="ctx" className="model-details-usage">
            {tr("modelpicker.contextUsedValue", {
              used: (usage ?? 0).toLocaleString(getLocale()),
              percent,
            })}
            <i className="model-details-meter" aria-hidden="true"><b style={{ width: `${percent}%` }} /></i>
          </span>] as [string, ReactNode]]
      : []),
  ];
  return (
    <div ref={detailsRef} className="model-details">
      <Button type="button" className="model-details-back" size="sm" variant="ghost" iconStart={BackIcon} onClick={onBack}>
        {tr("common.back")}
      </Button>
      <div className="model-details-head">
        <ProviderLogo
          providerID={model.providerID}
          providerName={model.providerName}
          harnessId={model.harnessId}
          className="model-row-provider-logo"
        />
        <div className="model-details-title">
          <strong>{model.name}</strong>
          <small>{model.modelID}</small>
        </div>
      </div>
      <dl className="model-details-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="model-details-actions">
        {selected
          ? <span className="model-details-current">{tr("modelpicker.currentModel")}</span>
          : (
            <Button type="button" className="model-details-use" variant="primary" onClick={onUse}>
              {tr("modelpicker.useThisModel")}
            </Button>
          )}
      </div>
    </div>
  );
}

export function ModelHoverDetails({ model, favorite, showFavorite = true }: { model: ModelDescriptor; favorite: boolean; showFavorite?: boolean }) {
  const capabilities = new Set((model.capabilities ?? []).map((capability) => capability.toLowerCase()));
  const icon = (label: string, node: ReactNode) => <span title={label} aria-label={label}>{node}</span>;
  const cost = model.cost;
  const prices = hasModelPricing(cost) && (
    <div className="model-hover-pricing">
      <span>Input <b>{formatModelPrice(cost.input)} <i>/ 1M tokens</i></b></span>
      <span>Output <b>{formatModelPrice(cost.output)} <i>/ 1M tokens</i></b></span>
    </div>
  );
  return (
    <div className="model-hover-details">
      <header>
        <ProviderLogo providerID={model.providerID} providerName={model.providerName} harnessId={model.harnessId} className="model-row-provider-logo" />
        <div><strong>{model.name}</strong><small>{model.providerName ?? model.providerID}</small></div>
        {showFavorite && <FavoriteIcon className={`model-hover-star${favorite ? " on" : ""}`} aria-label={favorite ? tr("modelpicker.removeFavorite") : tr("modelpicker.addFavorite")} />}
      </header>
      <div className="model-hover-capabilities" aria-label={tr("modelpicker.modalities")}>
        {icon(tr("modelpicker.text"), <Icon.text />)}
        {[...capabilities].some((capability) => capability.endsWith(":image")) && icon(tr("modelpicker.image"), <Icon.image />)}
        {[...capabilities].some((capability) => capability.endsWith(":audio")) && icon(tr("modelpicker.audio"), <Icon.speaker />)}
        {[...capabilities].some((capability) => capability.endsWith(":video")) && icon(tr("modelpicker.video"), <Icon.video />)}
        {capabilities.has("toolcall") && icon(tr("modelpicker.toolCalls"), <Icon.workflow />)}
      </div>
      <div className="model-hover-tags">
        {capabilities.has("toolcall") && <span>{tr("modelpicker.toolCalls")}</span>}
        {modelSupportsThinking(model) && <span>{tr("modelpicker.reasoning")}</span>}
        {capabilities.size > 0 && <span>{tr("modelpicker.modalities")}</span>}
      </div>
      <p className="model-hover-context">◉ {model.context ? `${model.context.toLocaleString(getLocale())} ${tr("modelpicker.contextWindow").toLowerCase()}` : tr("modelpicker.contextUnknown")}</p>
      {prices}
    </div>
  );
}
