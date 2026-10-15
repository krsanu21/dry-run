import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Containment for rendering failures. Without a boundary, one exception in any
 * component (or effect) unmounts the whole application and leaves a blank page.
 * Each region of the app gets its own boundary, so a failure in one panel leaves
 * the others — and the user's code — untouched, and the failed panel recovers by
 * itself when what it was showing changes (`resetKeys`).
 */

export interface ErrorBoundaryProps {
  /** what failed, in the user's words: "the visualization", "the editor" */
  region: string;
  children: ReactNode;
  /** when any of these change, the boundary tries to render its children again */
  resetKeys?: readonly unknown[];
  /** extra recovery action shown next to "Try again", e.g. clearing the current trace */
  recover?: { label: string; run(): void };
  /** the root boundary also offers a reload */
  root?: boolean;
  /** called once per caught error, e.g. to flush unsaved work */
  onError?(error: Error): void;
}

interface State {
  error: Error | null;
  componentStack: string;
}

function sameKeys(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: (info.componentStack ?? "").trim() });
    console.error(`[dry run] ${this.props.region} failed to render:`, error, info.componentStack);
    try {
      this.props.onError?.(error);
    } catch {
      // reporting must never throw
    }
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && !sameKeys(prev.resetKeys, this.props.resetKeys)) this.reset();
  }

  private reset = (): void => this.setState({ error: null, componentStack: "" });

  private details(): string {
    const e = this.state.error;
    return [`Dry Run — ${this.props.region} failed`, `${e?.name ?? "Error"}: ${e?.message ?? ""}`, e?.stack ?? "", this.state.componentStack, `at ${new Date().toISOString()}`, navigator.userAgent].filter(Boolean).join("\n");
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { region, recover, root } = this.props;
    return (
      <div className={`crash-card${root ? " is-root" : ""}`} role="alert" data-testid="crash-card" data-region={region}>
        <h3>Something went wrong in {region}</h3>
        <p>
          {root ? "The app hit an unexpected error." : "The rest of the app is still working."} Your code is saved in this browser and has not been changed.
        </p>
        <p className="crash-msg">
          <code>{error.message || String(error)}</code>
        </p>
        <div className="crash-actions">
          <button type="button" className="btn primary" onClick={this.reset} data-testid="crash-retry">
            Try again
          </button>
          {recover && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                recover.run();
                this.reset();
              }}
              data-testid="crash-recover"
            >
              {recover.label}
            </button>
          )}
          {root && (
            <button type="button" className="btn" onClick={() => location.reload()}>
              Reload the page
            </button>
          )}
          <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(this.details()).catch(() => undefined)}>
            Copy error details
          </button>
        </div>
        <details>
          <summary>Technical details</summary>
          <pre>{this.details()}</pre>
        </details>
      </div>
    );
  }
}
