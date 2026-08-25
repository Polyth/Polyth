// Standard view-level error boundary. Deliberately createElement-based (a .ts
// file, not .tsx): Node's type stripping cannot load JSX, and the DOM-free
// node:test suite imports WorkspaceHost.ts, which mounts this boundary around
// every workspace surface (EXTENSION-SEAMS slice 2).
import { Component, createElement, type ErrorInfo, type ReactNode } from "react";
import { setActiveView } from "../store.ts";
import { tr } from "../i18n/index.ts";

interface ViewErrorBoundaryProps {
  /** Optional in the type so createElement callers may pass children last. */
  children?: ReactNode;
  resetKey: string;
  /** Render the fallback without the <main> page wrapper — for boundaries
   *  nested inside an already-laid-out region (WorkspaceHost). */
  inline?: boolean;
}

interface ViewErrorBoundaryState {
  error: Error | null;
}

export default class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  state: ViewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ViewErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("View failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: ViewErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const card = createElement(
      "div",
      { className: "empty-state surface-error", role: "alert" },
      createElement("span", { className: "empty-state-mark", "aria-hidden": true }, "!"),
      createElement("h2", { className: "empty-state-title" }, tr("viewerrorboundary.viewCouldNotRender")),
      createElement("p", { className: "empty-state-desc" }, tr("viewerrorboundary.workspaceStillAvailable")),
      createElement(
        "details",
        { className: "surface-error-details" },
        createElement("summary", null, tr("viewerrorboundary.technicalDetails")),
        createElement("code", null, this.state.error.message || tr("viewerrorboundary.unknownRenderingError")),
      ),
      createElement(
        "div",
        { className: "surface-error-actions" },
        createElement("button", { className: "primary-btn", onClick: this.retry }, tr("viewerrorboundary.tryAgain")),
        createElement("button", { onClick: () => setActiveView("session") }, tr("viewerrorboundary.returnToSession")),
      ),
    );
    return this.props.inline ? card : createElement("main", { className: "main" }, card);
  }
}
