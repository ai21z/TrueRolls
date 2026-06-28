import { useEffect } from 'react';
import { useKarmaState } from './hooks/useKarmaState';
import { Landing } from './landing/Landing';
import { Docs } from './landing/docs/Docs';
import { Verify } from './landing/verify/Verify';
import { EntropyNet } from './components/EntropyNet';
import { useHashView } from './landing/useHashView';
import css from './components/App.module.css';

export default function App() {
  const state = useKarmaState();
  const view = useHashView();
  const { isRolling, roll } = state;

  // Global shortcut: Space to roll - only on the landing view, where the dice UI
  // is mounted. On Docs/Verify this would otherwise fire invisible rolls and
  // swallow the page's Space-to-scroll.
  useEffect(() => {
    if (view !== 'landing') return;
    const handler = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isRolling) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
        e.preventDefault();
        roll();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [view, isRolling, roll]);

  if (!state.ready) {
    return (
      <div className={css.loading}>
        <span className={css.loadingText}>Connecting…</span>
      </div>
    );
  }

  const page =
    view === 'docs' ? <Docs /> : view === 'verify' ? <Verify /> : <Landing state={state} />;

  return (
    <>
      {view === 'landing' && <EntropyNet />}
      {page}
    </>
  );
}
