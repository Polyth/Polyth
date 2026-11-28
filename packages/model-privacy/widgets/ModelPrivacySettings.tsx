// Settings → Model privacy: which marks show, the composer chip, and the
// snapshot's date and source.
import { useMemo, type ReactNode } from "react";
import { PageHead, Row, Section, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { POLICY_MANIFEST } from "../src/policies.ts";
import { createModelPrivacyCopy, fill, formatCheckedDate } from "./copy.ts";
import { useDocumentLocale } from "./locale.ts";
import { updateModelPrivacyPrefs, useModelPrivacyPrefs } from "./prefs.ts";

export default function ModelPrivacySettings(): ReactNode {
  const locale = useDocumentLocale();
  const copy = useMemo(() => createModelPrivacyCopy(locale), [locale]);
  const text = copy.settings;
  const prefs = useModelPrivacyPrefs();
  const date = formatCheckedDate(POLICY_MANIFEST.checkedAt, locale);
  return (
    <div className="model-privacy-settings">
      <PageHead title={text.page} blurb={text.blurb} />
      <Section title={text.marksSection} itemId="model-privacy.marks">
        <Row label={text.all} hint={text.allHint}>
          <Toggle on={prefs.showAll} onChange={(showAll) => updateModelPrivacyPrefs({ showAll })} label={text.all} />
        </Row>
        <Row label={text.chip} hint={text.chipHint} itemId="model-privacy.chip">
          <Toggle on={prefs.composerChip} onChange={(composerChip) => updateModelPrivacyPrefs({ composerChip })} label={text.chip} />
        </Row>
      </Section>
      <Section title={text.sourceSection} itemId="model-privacy.source">
        <p className="model-privacy-source-hint">{fill(text.sourceHint, { date })}</p>
        <ul className="model-privacy-sources">
          {Object.entries(POLICY_MANIFEST.sources).map(([id, source]) => (
            <li key={id}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
