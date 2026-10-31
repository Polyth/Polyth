// Settings → Peak pricing: whether the chip shows, how much of it, and the
// hover summary, with a live preview drawn by the chip's own presentation.
import { useMemo, type ReactNode } from "react";
import { ChevronDownIcon } from "@polyth/web/ui";
import { PageHead, Row, Section, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { formatRemaining, type PricePhase } from "../src/schedule.ts";
import { createPeakPricingCopy } from "./copy.ts";
import PeakPricingChip from "./PeakPricingChip.tsx";
import { useDocumentLocale } from "./locale.ts";
import { updatePeakPricingPrefs, usePeakPricingPrefs, type PeakPricingDisplay } from "./prefs.ts";

/** Fixed sample moments, so the preview never ticks or changes width. */
const PREVIEW: ReadonlyArray<{ phase: PricePhase; remainingMs: number; progress: number }> = [
  { phase: "off-peak", remainingMs: (13 * 60 + 14) * 60_000, progress: 0.38 },
  { phase: "peak", remainingMs: (1 * 60 + 21) * 60_000, progress: 0.66 },
];

export default function PeakPricingSettings(): ReactNode {
  const locale = useDocumentLocale();
  const copy = useMemo(() => createPeakPricingCopy(locale), [locale]);
  const text = copy.settings;
  const prefs = usePeakPricingPrefs();
  const off = !prefs.enabled;
  const displayOptions: Array<[PeakPricingDisplay, string]> = [
    ["full", text.full],
    ["compact", text.compact],
    ["dot", text.dot],
  ];

  return (
    <div className="peak-pricing-settings">
      <PageHead title={text.page} blurb={text.blurb} />

      <Section title={text.chipSection} itemId="peak-pricing.chip">
        <Row label={text.show} hint={text.showHint}>
          <Toggle on={prefs.enabled} onChange={(enabled) => updatePeakPricingPrefs({ enabled })} label={text.show} />
        </Row>
        <Row label={text.display} hint={text.displayHint} itemId="peak-pricing.display" disabled={off}>
          <Seg
            label={text.display}
            value={prefs.display}
            disabled={off}
            onChange={(display) => updatePeakPricingPrefs({ display })}
            options={displayOptions}
          />
        </Row>
      </Section>

      <Section title={text.detailsSection}>
        <Row label={text.tooltip} hint={text.tooltipHint} itemId="peak-pricing.tooltip" disabled={off}>
          <Toggle
            on={prefs.tooltip}
            disabled={off}
            onChange={(tooltip) => updatePeakPricingPrefs({ tooltip })}
            label={text.tooltip}
          />
        </Row>
      </Section>

      <Section title={text.previewSection}>
        {/* A picture of the chip, not a control: inert keeps it out of the tab
            order and the accessibility tree while staying the real markup. */}
        <div className="peak-pricing-preview" data-enabled={prefs.enabled} aria-hidden="true" inert>
          {PREVIEW.map((sample) => (
            <div className="peak-pricing-preview-line" key={sample.phase}>
              <span className="config-chip peak-pricing-preview-model">
                <span className="config-chip-text">{text.previewModel}</span>
                <span className="config-chip-caret"><ChevronDownIcon size={12} strokeWidth={2} /></span>
              </span>
              <span className="peak-pricing" data-display={prefs.display}>
                <PeakPricingChip
                  phase={sample.phase}
                  display={prefs.display}
                  progress={sample.progress}
                  stateLabel={sample.phase === "peak" ? copy.peak : copy.offPeak}
                  remaining={formatRemaining(sample.remainingMs, copy.duration)}
                  tabIndex={-1}
                />
              </span>
            </div>
          ))}
        </div>
        <p className="peak-pricing-settings-note">{off ? `${text.hidden} ${text.noSchedule}` : text.noSchedule}</p>
      </Section>
    </div>
  );
}
