import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level crash catcher. A render/lifecycle throw anywhere below this
 * boundary (e.g. a provider blowing up on boot) would otherwise unmount the
 * whole tree to a blank white page with only a console error. Instead we show
 * a branded, actionable fallback with a reload button.
 *
 * Mounted as the OUTERMOST wrapper in main.tsx so it also catches failures in
 * the top-level providers inside <App> (AppProvider, QueryClientProvider, …).
 *
 * Note: this catches render-phase errors, not async/event-handler errors —
 * those still surface through the normal console/toast paths.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error in React tree:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground"
      >
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The app hit an unexpected error and couldn't continue. Reloading
          usually clears it.
        </p>
        {import.meta.env.DEV && (
          <pre className="max-w-full max-h-40 overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
            {error.message}
          </pre>
        )}
        <button
          type="button"
          onClick={this.handleReload}
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reload
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
