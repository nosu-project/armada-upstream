import { Component, type ErrorInfo, type ReactNode } from "react";

import { clearChunkReloadGuard, isChunkLoadError, tryChunkReload } from "@/lib/chunkReload";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level crash catcher (outermost wrapper in main.tsx) showing a fallback
 * with reload instead of a blank page. Catches render-phase errors only.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    // Stale chunks after a deploy surface here (e.g. "useContext(...) is null");
    // hard-reload once per session, then fall through to avoid looping.
    if (isChunkLoadError(error) && tryChunkReload()) {
      return { error: null };
    }
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error in React tree:", error, info.componentStack);
  }

  private handleReload = () => {
    clearChunkReloadGuard();
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
        {/* Shown in production: the only field diagnostic on a phone. */}
        <pre className="max-w-full max-h-40 overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground select-text whitespace-pre-wrap break-words">
          {error.name}: {error.message}
        </pre>
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
