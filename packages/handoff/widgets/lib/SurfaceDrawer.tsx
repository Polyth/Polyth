import type { ReactNode } from "react";
import { Button } from "../../../../apps/web/src/components/ui/index.ts";
import { englishHandoff, type HandoffTranslate } from "./i18n.ts";

export function SurfaceDrawer(props: {
  title: string;
  onClose(): void;
  footer?: ReactNode;
  children: ReactNode;
  translate?: HandoffTranslate;
}) {
  const t = props.translate ?? englishHandoff;
  return (
    <div className="handoff-surface-drawer" role="presentation">
      <button type="button" className="handoff-surface-drawer-backdrop" aria-label={t("handoff.drawer.close")} onClick={props.onClose} />
      <div className="handoff-surface-drawer-panel" role="dialog" aria-modal="true" aria-label={props.title}>
        <header className="handoff-surface-drawer-head">
          <h3 className="handoff-surface-drawer-title">{props.title}</h3>
          <Button size="sm" variant="ghost" onClick={props.onClose} aria-label={t("handoff.drawer.close")}>×</Button>
        </header>
        <div className="handoff-surface-drawer-body">{props.children}</div>
        {props.footer ? <footer className="handoff-surface-drawer-foot">{props.footer}</footer> : null}
      </div>
    </div>
  );
}
