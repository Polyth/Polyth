// Draws `modelAnnotations` (see modelAnnotations.ts): a quiet mark beside a
// model's name, and the full statement inside the model details cards.
import type { ReactNode } from "react";
import { Tooltip } from "@polyth/web/ui";
import { Icon } from "@polyth/web/icons";
import {
  modelAnnotations,
  useModelAnnotationsVersion,
  type ModelAnnotationIcon,
  type ModelAnnotationTarget,
  type ResolvedModelAnnotation,
} from "./modelAnnotations.ts";

function Glyph({ icon }: { icon: ModelAnnotationIcon }): ReactNode {
  if (icon === "shield") return <Icon.shield />;
  if (icon === "question") return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5" />
      <path d="M12 16.8h.01" />
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const plainText = (annotation: ResolvedModelAnnotation): string =>
  [annotation.label, annotation.detail, annotation.meta].filter(Boolean).join("\n");

const markKey = (annotation: ResolvedModelAnnotation): string => `${annotation.sourceId}:${annotation.key}`;

/** Inline marks beside a model name. `tooltip` uses the shared Tooltip and
 *  makes the mark focusable (settings rows); without it the mark carries a
 *  native title, for rows that are themselves one interactive target (the
 *  picker, whose hover card already shows the full statement). */
export function ModelAnnotationMarks({ model, tooltip = false }: { model: ModelAnnotationTarget; tooltip?: boolean }): ReactNode {
  useModelAnnotationsVersion();
  const inline = modelAnnotations(model).filter((annotation) => annotation.inline);
  if (inline.length === 0) return null;
  return (
    <span className="model-annotation-marks">
      {inline.map((annotation) => {
        const mark = (
          <span
            className={`model-annotation-mark tone-${annotation.tone}`}
            role="img"
            aria-label={annotation.label}
            data-annotation={markKey(annotation)}
            {...(tooltip ? { tabIndex: 0 } : { title: plainText(annotation) })}
          >
            <Glyph icon={annotation.icon} />
          </span>
        );
        return tooltip
          ? (
            <Tooltip
              key={markKey(annotation)}
              content={(
                <span className="model-annotation-tip">
                  <b>{annotation.label}</b>
                  {annotation.detail && <span>{annotation.detail}</span>}
                  {annotation.meta && <small>{annotation.meta}</small>}
                </span>
              )}
            >
              {mark}
            </Tooltip>
          )
          : <span key={markKey(annotation)} className="model-annotation-slot">{mark}</span>;
      })}
    </span>
  );
}

function AnnotationStatement({ annotation }: { annotation: ResolvedModelAnnotation }): ReactNode {
  return (
    <span className={`model-annotation-statement tone-${annotation.tone}`} data-annotation={markKey(annotation)}>
      <span className="model-annotation-line">
        <span className="model-annotation-mark" aria-hidden="true"><Glyph icon={annotation.icon} /></span>
        <b>{annotation.label}</b>
      </span>
      {annotation.detail && <span className="model-annotation-detail">{annotation.detail}</span>}
      {(annotation.meta || annotation.href) && (
        <small className="model-annotation-meta">
          {annotation.meta}
          {annotation.meta && annotation.href && " · "}
          {annotation.href && (
            <a href={annotation.href} target="_blank" rel="noopener noreferrer">
              {annotation.hrefLabel ?? new URL(annotation.href).host}
            </a>
          )}
        </small>
      )}
    </span>
  );
}

/** Details rows (`[heading, value]`) for the phone details grid. */
export function useModelAnnotationRows(model: ModelAnnotationTarget): Array<[string, ReactNode]> {
  useModelAnnotationsVersion();
  return modelAnnotations(model).map((annotation) => [
    annotation.heading,
    <AnnotationStatement key={markKey(annotation)} annotation={annotation} />,
  ]);
}

/** Every annotation as a block, for the desktop hover card. */
export function ModelAnnotationDetails({ model }: { model: ModelAnnotationTarget }): ReactNode {
  useModelAnnotationsVersion();
  const annotations = modelAnnotations(model);
  if (annotations.length === 0) return null;
  return (
    <div className="model-hover-annotations">
      {annotations.map((annotation) => (
        <div key={markKey(annotation)}>
          <span className="model-hover-annotation-heading">{annotation.heading}</span>
          <AnnotationStatement annotation={annotation} />
        </div>
      ))}
    </div>
  );
}
