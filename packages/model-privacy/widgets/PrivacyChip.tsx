// The composer chip: shown only when the next turn's model may keep or train
// on what is sent, or its provider does not say. Click opens the source.
import type { ReactNode } from "react";
import { Tooltip } from "@polyth/web/ui";
import type { ModelAnnotationTarget } from "@polyth/models/model-annotations";
import { useDocumentLocale } from "./locale.ts";
import { useModelPrivacyPrefs } from "./prefs.ts";
import { privacyStatement } from "./presentation.ts";

function HelpGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5" />
      <path d="M12 16.8h.01" />
    </svg>
  );
}

function EyeGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function PrivacyChip({ model }: { model: ModelAnnotationTarget }): ReactNode {
  const locale = useDocumentLocale();
  const prefs = useModelPrivacyPrefs();
  if (!prefs.composerChip) return null;
  const statement = privacyStatement(model, locale);
  if (!statement || !statement.look.chip) return null;
  return (
    <span className="model-privacy">
      <Tooltip
        content={(
          <span className="model-privacy-tip">
            <b>{statement.label}</b>
            <span>{statement.detail}</span>
            <small>{statement.meta}</small>
          </span>
        )}
      >
        <a
          className={`config-chip model-privacy-chip tone-${statement.look.tone}`}
          href={statement.resolved.source.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${statement.label}. ${statement.detail}`}
          data-policy={statement.resolved.policy}
        >
          <span className="model-privacy-glyph" aria-hidden="true">
            {statement.look.icon === "question" ? <HelpGlyph /> : <EyeGlyph />}
          </span>
          <span className="model-privacy-text">{statement.chip}</span>
        </a>
      </Tooltip>
    </span>
  );
}
