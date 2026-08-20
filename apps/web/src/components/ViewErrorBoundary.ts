// Standard view-level error boundary. Deliberately createElement-based (a .ts
// file, not .tsx): Node's type stripping cannot load JSX, and the DOM-free
// node:test suite imports WorkspaceHost.ts, which mounts this boundary around
// every workspace surface (EXTENSION-SEAMS slice 2).
import { Component, createElement, type ErrorInfo, type ReactNode } from "react";
import { setActiveView } from "../store.ts";

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
      createElement("h2", { className: "empty-state-title" }, "This view couldn’t render"),
      createElement("p", { className: "empty-state-desc" }, "The rest of your workspace is still available."),
      createElement(
        "details",
        { className: "surface-error-details" },
        createElement("summary", null, "Technical details"),
        createElement("code", null, this.state.error.message || "Unknown rendering error"),
      ),
      createElement(
        "div",
        { className: "surface-error-actions" },
        createElement("button", { className: "primary-btn", onClick: this.retry }, "Try again"),
        createElement("button", { onClick: () => setActiveView("session") }, "Return to session"),
      ),
    );
    return this.props.inline ? card : createElement("main", { className: "main" }, card);
  }
}
