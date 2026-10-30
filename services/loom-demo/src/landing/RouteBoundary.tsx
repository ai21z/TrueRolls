import { Component, useLayoutEffect, useRef, type ReactNode } from 'react';
import { focusHeading } from './useHashView';
import { isChunkLoadError } from './viewLoader';
import css from './RouteBoundary.module.css';

type Props = {
  /** Reader-facing name of the view, e.g. "Docs". */
  label: string;
  /** Times the reader has asked to try this view again. */
  attempt: number;
  /** A roll is still waiting for its receipt: reloading could lose it. Completed receipts survive a reload. */
  rollPending: boolean;
  onRetry: () => void;
  /** The view failed; the next attempt must not reuse React's cached rejection. */
  onFailed: () => void;
  children: ReactNode;
};

type State = { error: unknown };

/**
 * Contains a failure to download or render one view. It sits below the state
 * that owns rolls and receipts, so that state survives, and Home keeps working.
 * Nothing reloads or retries on its own.
 */
export class RouteBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch() {
    this.props.onFailed();
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <ViewFailed
        label={this.props.label}
        download={isChunkLoadError(this.state.error)}
        attempt={this.props.attempt}
        rollPending={this.props.rollPending}
        onRetry={this.props.onRetry}
      />
    );
  }
}

/** Shown while a view's code downloads. The text appears only if it takes a moment. */
export function ViewLoading({ label }: { label: string }) {
  return (
    <main className={`view-loading ${css.page}`} aria-busy="true">
      <p className={css.loading} role="status">
        Loading {label}…
      </p>
      <a className={css.home} href="#">
        Back to home
      </a>
    </main>
  );
}

function ViewFailed({
  label,
  download,
  attempt,
  rollPending,
  onRetry,
}: {
  label: string;
  download: boolean;
  attempt: number;
  rollPending: boolean;
  onRetry: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    document.title = `${label} did not load · TrueRolls`;
    window.scrollTo({ top: 0, behavior: 'auto' });
    focusHeading(heading.current);
  }, [label, attempt]);

  return (
    <main className={`view-loading ${css.page}`}>
      <h1 ref={heading} className={css.title}>
        {label} did not load.
      </h1>
      <p className={css.body} role="alert">
        {download
          ? attempt === 0
            ? `The ${label} page could not be downloaded. Check your connection and try again.`
            : `The ${label} page still could not be downloaded.`
          : `The ${label} page stopped with an error.`}{' '}
        Rolls and receipts from this tab are unaffected.
      </p>
      <div className={css.actions}>
        <button type="button" className={css.primary} onClick={onRetry}>
          Try again
        </button>
        <a className={css.home} href="#">
          Back to home
        </a>
      </div>
      {attempt > 0 && (
        <div className={css.reload}>
          <p className={css.note}>
            This browser can keep a failed download until TrueRolls reloads. Reloading downloads
            every file again and keeps the latest 100 completed receipts in this tab&rsquo;s history;
            an edited copy and the die and κ settings start over.
            {rollPending && ' Wait for the roll in progress to return its receipt first: reloading now could lose it.'}
          </p>
          <button
            type="button"
            className={css.secondary}
            disabled={rollPending}
            onClick={() => window.location.reload()}
          >
            Reload TrueRolls
          </button>
        </div>
      )}
    </main>
  );
}
