import { Component, type ReactNode } from 'react';

type Props = { fallback: ReactNode; children: ReactNode };

/**
 * Keeps a decorative part's fallback when its code fails to download or render.
 * Nothing else depends on the decoration, so the page, its rolls and its
 * navigation carry on, and nothing is retried.
 */
export class DecorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
