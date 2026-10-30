import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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

/*
 * Scroll memory is kept per history entry, not per view: Back and Forward return
 * to where the reader was in that entry, including in-page entries a view pushes
 * itself (a Docs section). Each entry is tagged in history.state with a key the
 * first time it is seen; an untagged entry is a new navigation.
 */
const ENTRY_KEY = '__trEntry';
const scrollPositions = new Map<string, number>();
let entrySeq = 0;
let currentEntry: string | null = null;
// Position captured when an in-page link is activated, before the browser's own
// fragment scroll (a docs section can share a route's id) moves the page.
let leaveY: number | null = null;

export type Navigation =
  | { kind: 'initial' }
  | { kind: 'new' }
  | { kind: 'traverse'; restore: number | null };
let lastNav: Navigation = { kind: 'initial' };

// Navigation identity, separate from the view: Back can return to the view still
// on screen while another view's code is loading, and that is a navigation too.
let navSeq = 0;
// The navigation whose scroll and focus have been applied.
let appliedNav = 0;
// The view whose content last committed (see ViewCommitted).
let settledView: HashView | null = null;

/** How the current history entry was reached. */
export function lastNavigation(): Navigation {
  return lastNav;
}

function entryKeyOf(state: unknown): string | null {
  if (state && typeof state === 'object' && ENTRY_KEY in state) {
    const key = (state as Record<string, unknown>)[ENTRY_KEY];
    return typeof key === 'string' ? key : null;
  }
  return null;
}

function newEntryKey(): string {
  entrySeq += 1;
  return `${Date.now().toString(36)}-${entrySeq}`;
}

function withEntryKey(state: unknown, key: string): Record<string, unknown> {
  const base = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  return { ...base, [ENTRY_KEY]: key };
}

/** Tag the current entry if needed. `fresh` means it had never been seen. */
function tagCurrentEntry(): { key: string; fresh: boolean } {
  const existing = entryKeyOf(window.history.state);
  if (existing) return { key: existing, fresh: false };
  const key = newEntryKey();
  window.history.replaceState(withEntryKey(window.history.state, key), '');
  return { key, fresh: true };
}

function rememberLeaving() {
  if (currentEntry !== null) scrollPositions.set(currentEntry, leaveY ?? window.scrollY);
  leaveY = null;
}

/**
 * Push an in-page history entry (a view's own section link) so Back and Forward
 * treat it like any other entry. The view scrolls to the section itself.
 */
export function pushViewEntry(url: string) {
  rememberLeaving();
  const key = newEntryKey();
  window.history.pushState(withEntryKey(null, key), '', url);
  currentEntry = key;
  lastNav = { kind: 'new' };
  navSeq += 1;
  appliedNav = navSeq;
}

/**
 * The view is 'docs' when the hash starts with '#docs', 'verify' when it starts
 * with '#verify', 'behind' when it starts with '#behind' (all also accept a
 * leading slash), otherwise 'landing'. `nav` changes on every history navigation.
 */
export function useHashView(): { view: HashView; nav: number } {
  const [route, setRoute] = useState(() => ({ view: readView(), nav: navSeq }));
  const current = useRef<HashView>(route.view);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Popstate and hashchange both fire for most traversals; the entry key makes
    // the second one a no-op.
    const onNavigate = () => {
      const { key, fresh } = tagCurrentEntry();
      if (key === currentEntry) return;
      // Record the outgoing entry's position before the state update: React may
      // render the new view synchronously inside this handler.
      rememberLeaving();
      currentEntry = key;
      navSeq += 1;
      const next = readView();
      // Same view as the one on screen, with nothing else pending (a docs section
      // entry): the DOM is already in place, so this navigation is applied here.
      // Anything else is applied in ViewCommitted once the target view commits.
      const inPlace = next === settledView && current.current === settledView;
      if (fresh) {
        lastNav = { kind: 'new' };
      } else {
        const restore = scrollPositions.get(key) ?? null;
        lastNav = { kind: 'traverse', restore };
        if (inPlace && restore !== null) window.scrollTo({ top: restore, behavior: 'auto' });
      }
      if (inPlace) appliedNav = navSeq;
      current.current = next;
      setRoute({ view: next, nav: navSeq });
    };
    if (currentEntry === null) currentEntry = tagCurrentEntry().key;
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    // Sync once on mount in case the hash changed before listeners attached.
    onNavigate();
    return () => {
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('hashchange', onNavigate);
    };
  }, []);

  return route;
}

export const VIEW_TITLES: Record<HashView, string> = {
  landing: 'TrueRolls, verifiable dice',
  verify: 'Verify a receipt · TrueRolls',
  behind: 'Behind a roll · TrueRolls',
  docs: 'Docs · TrueRolls',
};

/** In-page targets the views scroll to themselves (deep links). */
function hashTargetsSection(hash: string): boolean {
  return /^#\/?docs-.+/.test(hash) || hash === '#play' || hash === '#playground';
}

/** Focus a heading without scrolling to it (it is already in view, or the page handles it). */
export function focusHeading(el: HTMLElement | null) {
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/**
 * View changes behave like page navigations, and in-page link positions are
 * captured for Back/Forward. The title, scrolling and focus are applied in
 * ViewCommitted, once the new view's content exists. Section deep links
 * (#docs-…, #play) are left to the view that owns the section.
 */
export function useViewNavigation() {
  useEffect(() => {
    // Bubble phase, after the app's own handlers: a link whose default the app
    // prevented (e.g. a docs TOC entry) records its own entry instead.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (a && a.href !== window.location.href) leaveY = window.scrollY;
    };
    // The views are swapped in place, so the browser's own per-entry restore would
    // apply one view's offset to another's DOM. This module restores positions itself.
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

/**
 * Rendered after a view's content (inside the same Suspense boundary), so it
 * commits only once that content exists. A navigation not yet applied then
 * starts at the top, or at the restored position for Back/Forward, with focus on
 * the main heading. That includes Back to the view still on screen while
 * another view was loading.
 */
export function ViewCommitted({ view, nav: navId }: { view: HashView; nav: number }) {
  useLayoutEffect(() => {
    document.title = VIEW_TITLES[view];
    const first = settledView === null;
    settledView = view;
    if (first || appliedNav === navSeq) {
      appliedNav = navSeq;
      return;
    }
    appliedNav = navSeq;

    const nav = lastNavigation();
    if (nav.kind === 'traverse') {
      window.scrollTo({ top: nav.restore ?? 0, behavior: 'auto' });
    } else if (!hashTargetsSection(window.location.hash)) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
    focusHeading(document.querySelector<HTMLElement>('main h1'));
  }, [view, navId]);
  return null;
}
