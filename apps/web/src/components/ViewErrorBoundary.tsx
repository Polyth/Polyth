import { Component, type ErrorInfo, type ReactNode } from "react";
import { setActiveView } from "../store.ts";

interface ViewErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
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
    return (
      <main className="main">
        <div className="empty-state surface-error" role="alert">
          <span className="empty-state-mark" aria-hidden>!</span>
          <h2 className="empty-state-title">This view couldn’t render</h2>
          <p className="empty-state-desc">The rest of your workspace is still available.</p>
          <details className="surface-error-details">
            <summary>Technical details</summary>
            <code>{this.state.error.message || "Unknown rendering error"}</code>
          </details>
          <div className="surface-error-actions">
            <button className="primary-btn" onClick={this.retry}>Try again</button>
            <button onClick={() => setActiveView("session")}>Return to session</button>
          </div>
        </div>
      </main>
    );
  }
}
