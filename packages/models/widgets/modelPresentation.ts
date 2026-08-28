import type { ModelDescriptor } from "@polyth/contracts";
import {
  formatList,
  formatNumber,
  getLocale,
  tr,
} from "@polyth/web/i18n";

const MODALITY_ORDER = ["text", "image", "audio", "video", "pdf"];
const VARIANT_LABELS: Record<string, string> = { xhigh: "X-High" };

function modalityLabel(value: string): string {
  const labels: Record<string, string> = {
    text: tr("modelpicker.text"),
    image: tr("modelpicker.image"),
    audio: tr("modelpicker.audio"),
    video: tr("modelpicker.video"),
    pdf: tr("modelpicker.pdf"),
  };
  return labels[value.toLowerCase()] ?? value;
}

export function modelModalityValues(model: ModelDescriptor): string[] {
  const raw = (model.capabilities ?? [])
    .filter((capability) =>
      (capability.startsWith("input:") || capability.startsWith("output:"))
      && !capability.endsWith(":none"))
    .map((capability) => capability.slice(capability.indexOf(":") + 1).toLowerCase());
  const unique = [...new Set(raw)];
  if (unique.length === 0) unique.push("text");
  unique.sort((a, b) => {
    const left = MODALITY_ORDER.indexOf(a);
    const right = MODALITY_ORDER.indexOf(b);
    return (left < 0 ? MODALITY_ORDER.length : left)
      - (right < 0 ? MODALITY_ORDER.length : right)
      || a.localeCompare(b);
  });
  return unique;
}

export function modelModalityLabels(model: ModelDescriptor): string[] {
  return modelModalityValues(model).map(modalityLabel);
}

export function modelModalities(model: ModelDescriptor): string {
  return formatList(modelModalityLabels(model));
}

export function modelContextLabel(context?: number): string {
  if (!context) return tr("modelpicker.contextUnknown");
  if (context >= 1_000_000) {
    return tr("modelpicker.valueMContext", {
      value: formatNumber(context / 1_000_000, { maximumFractionDigits: 1 }),
    });
  }
  if (context >= 1_000) {
    return tr("modelpicker.valueKContext", { value: formatNumber(Math.round(context / 1_000)) });
  }
  return tr("modelpicker.valueContext", { value: formatNumber(context) });
}

function shortContext(context?: number): string | null {
  if (!context) return null;
  if (context >= 1_000_000) {
    return `${formatNumber(context / 1_000_000, { maximumFractionDigits: 1 })}M`;
  }
  if (context >= 1_000) return `${formatNumber(Math.round(context / 1_000))}K`;
  return formatNumber(context);
}

/** One calm metadata line: `Text · Image · 500K`. */
export function modelMetaLine(model?: ModelDescriptor): string {
  if (!model) return "";
  const context = shortContext(model.context);
  return [...modelModalityLabels(model), ...(context ? [context] : [])].join(" · ");
}

export function modelSupportsThinking(model: ModelDescriptor | undefined): boolean {
  return (model?.variants?.length ?? 0) > 0;
}

/** Display-only label; the backend always receives the raw variant id. */
export function thinkingVariantLabel(variant: string): string {
  if (variant.toLowerCase() === "none") return tr("common.none");
  const known = VARIANT_LABELS[variant.toLowerCase()];
  if (known) return known;
  const label = variant.replace(/[-_]+/g, " ").trim();
  return label ? label[0]!.toUpperCase() + label.slice(1) : variant;
}

function priceLine(cost?: { input: number; output: number }): string | null {
  if (!cost || (!cost.input && !cost.output)) return null;
  const formatPrice = (value: number) =>
    `$${formatNumber(value, { maximumFractionDigits: value < 1 ? 2 : 1 })}`;
  return tr("modelpicker.pricingPerMTok", {
    input: formatPrice(cost.input),
    output: formatPrice(cost.output),
  });
}

export interface ModelDetailsPresentation {
  provider: string;
  context: string;
  modalities: string;
  reasoning: string;
  tools: string;
  pricing: string | null;
  availability: string | null;
}

/** One fallback policy for every optional catalog field in the details view. */
export function modelDetailsPresentation(model: ModelDescriptor): ModelDetailsPresentation {
  return {
    provider: model.providerName?.trim() || model.providerID,
    context: model.context
      ? `${model.context.toLocaleString(getLocale())} ${tr("modelpicker.tokens")}`
      : tr("modelpicker.contextUnknown"),
    modalities: modelModalities(model),
    reasoning: modelSupportsThinking(model)
      ? formatList((model.variants ?? []).map(thinkingVariantLabel))
      : tr("modelpicker.notReported"),
    tools: (model.capabilities ?? []).includes("toolcall")
      ? tr("modelpicker.supported")
      : tr("modelpicker.notReported"),
    pricing: priceLine(model.cost),
    availability: model.connected === false ? tr("modelpicker.notConnected") : null,
  };
}
