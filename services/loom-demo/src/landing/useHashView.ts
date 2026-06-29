import { useEffect, useState } from 'react';

export type HashView = 'landing' | 'docs' | 'verify' | 'behind';

/** Read the current view from the URL hash. SSR-safe. */
function readView(): HashView {
  if (typeof window === 'undefined') return 'landing';
  const hash = window.location.hash;
  // Match '#docs', '#docs/...', '#/docs', '#/docs/...'
  if (hash.startsWith('#docs') || hash.startsWith('#/docs')) return 'docs';
  // Match '#verify', '#verify/...', '#/verify', '#/verify/...'
  if (hash.startsWith('#verify') || hash.startsWith('#/verify')) return 'verify';
  // Match '#behind', '#behind-a-roll', '#/behind...' (the Behind a TrueRoll page)
  if (hash.startsWith('#behind') || hash.startsWith('#/behind')) return 'behind';
  return 'landing';
}

/**
 * Returns 'docs' when the hash starts with '#docs', 'verify' when it starts with
 * '#verify', 'behind' when it starts with '#behind' (all also accept a leading
 * slash), otherwise 'landing'. Updates on the 'hashchange' event.
 */
export function useHashView(): HashView {
  const [view, setView] = useState<HashView>(readView);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => setView(readView());
    window.addEventListener('hashchange', onHashChange);
    // Sync once on mount in case the hash changed before listeners attached.
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return view;
}
