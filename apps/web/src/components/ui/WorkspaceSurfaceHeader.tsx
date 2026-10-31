import type { WebWorkspaceSurfaceHeaderProps } from "@polyth/web-sdk";
import "./WorkspaceSurfaceHeader.css";

/** Package content toolbar. The surrounding ModuleView owns window titles,
 * close controls and geometry; each surface supplies its own scope/actions. */
export default function WorkspaceSurfaceHeader({ scope, context, actions, children, className, label }: WebWorkspaceSurfaceHeaderProps) {
  return <header className={`workspace-surface-header${className ? ` ${className}` : ""}`} aria-label={label}>
    {scope && <div className="workspace-surface-header-scope">{scope}</div>}
    {(context || children) && <div className="workspace-surface-header-context">{context}{children}</div>}
    {actions && <div className="workspace-surface-header-actions">{actions}</div>}
  </header>;
}
