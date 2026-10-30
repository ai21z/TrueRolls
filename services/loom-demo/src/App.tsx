import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from 'react';
import { useKarmaState } from './hooks/useKarmaState';
import { Landing } from './landing/Landing';
import { EntropyNet } from './components/EntropyNet';
import { RouteBoundary, ViewLoading } from './landing/RouteBoundary';
import { focusHeading, useHashView, useViewNavigation, ViewCommitted } from './landing/useHashView';
import { viewLoader } from './landing/viewLoader';

// The landing page is the first view for almost every visitor, so only it ships in
// the main chunk. The other views load on demand, and in the background once the
// verifier engine has settled and the browser is idle.
type RouteView = 'docs' | 'verify' | 'behind';
const ROUTE_VIEWS: Record<RouteView, { label: string; load: () => Promise<ComponentType> }> = {
  docs: { label: 'Docs', load: viewLoader(() => import('./landing/docs/Docs'), (m) => m.Docs) },
  verify: { label: 'Verify', load: viewLoader(() => import('./landing/verify/Verify'), (m) => m.Verify) },
  behind: {
    label: 'Behind a roll',
    load: viewLoader(() => import('./landing/behind/BehindARoll'), (m) => m.BehindARoll),
  },
};

// React.lazy keeps a rejected load for good, so a failed view gets a new one.
const lazyView = (view: RouteView) => lazy(() => ROUTE_VIEWS[view].load().then((c) => ({ default: c })));

type RouteSlot = { View: ComponentType; attempt: number };

function useRouteViews() {
  const [slots, setSlots] = useState<Record<RouteView, RouteSlot>>(() => ({
    docs: { View: lazyView('docs'), attempt: 0 },
    verify: { View: lazyView('verify'), attempt: 0 },
    behind: { View: lazyView('behind'), attempt: 0 },
  }));
  // The failed view keeps its error on screen; the next navigation to it, or a
  // Try again, renders the fresh lazy component.
  const renew = useCallback((view: RouteView) => {
    setSlots((s) => ({ ...s, [view]: { ...s[view], View: lazyView(view) } }));
  }, []);
  const retry = useCallback((view: RouteView) => {
    setSlots((s) => ({ ...s, [view]: { ...s[view], attempt: s[view].attempt + 1 } }));
  }, []);
  return { slots, renew, retry };
}

function usePrefetchViews(engine: string) {
  useEffect(() => {
    if (engine !== 'ready' && engine !== 'failed') return;
    const prefetch = () => {
      void Promise.all(Object.values(ROUTE_VIEWS).map((v) => v.load())).catch(() => {
        /* a failed prefetch is tried again, under a new URL, by the navigation that needs it */
      });
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(prefetch, { timeout: 3000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(prefetch, 500);
    return () => window.clearTimeout(t);
  }, [engine]);
}

export default function App() {
  const state = useKarmaState();
  const { view, nav } = useHashView();
  const routes = useRouteViews();
  useViewNavigation();
  usePrefetchViews(state.engine);

  // No boot gate: every view renders immediately. API connectivity and the wasm
  // engine load in the background, and only the operations that need them wait.
  // Rolling is started by the Roll buttons only; there is no page-wide Space key,
  // so Space on the page or a link scrolls as usual and never mints.
  // ViewCommitted sits after the view inside the same boundary, so scroll and
  // focus are applied once the view's content has actually committed. A view that
  // fails is contained below this component, so rolls and receipts survive it.
  let page;
  if (view === 'landing') {
    page = (
      <>
        <Landing state={state} />
        <ViewCommitted view="landing" nav={nav} />
      </>
    );
  } else {
    const { label } = ROUTE_VIEWS[view];
    const { View, attempt } = routes.slots[view];
    page = (
      <RouteBoundary
        key={`${view}-${attempt}`}
        label={label}
        attempt={attempt}
        rollPending={state.isRolling}
        onRetry={() => routes.retry(view)}
        onFailed={() => routes.renew(view)}
      >
        <Suspense fallback={<ViewLoading label={label} />}>
          <View />
          <ViewCommitted view={view} nav={nav} />
        </Suspense>
      </RouteBoundary>
    );
  }

  return (
    <>
      <nav aria-label="Skip link">
        <a
          className="skip-link"
          href="#"
          onClick={(e) => {
            // Not a hash link: the hash is the router here, so move focus instead.
            e.preventDefault();
            focusHeading(document.querySelector<HTMLElement>('main h1'));
            document.querySelector('main h1')?.scrollIntoView({ block: 'start' });
          }}
        >
          Skip to main content
        </a>
      </nav>
      {view === 'landing' && <EntropyNet />}
      {page}
    </>
  );
}
