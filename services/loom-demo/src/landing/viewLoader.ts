/**
 * Loads the code for a view that ships in its own chunk.
 *
 * A browser keeps a failed module download for the life of the page: Chromium
 * rejects a repeat import() of the same URL without fetching it again, and a
 * failed background prefetch would poison the later navigation the same way.
 * After a failure, the next attempt therefore asks for the chunk under a new
 * URL when the error names it. Nothing retries on its own: the next attempt is
 * the next navigation to the view, or the reader's Try again.
 *
 * This only reaches the view's own chunk. A chunk it imports, such as the
 * verifier hook Verify and Behind a roll share, keeps its URL, so a failure
 * there lasts until the page reloads; the view's error offers that reload.
 */
export function viewLoader<M, C>(importer: () => Promise<M>, pick: (module: M) => C): () => Promise<C> {
  let loading: Promise<C> | null = null;
  let failedUrl: string | null = null;
  let attempt = 0;
  return () => {
    if (loading) return loading;
    const run =
      failedUrl === null
        ? importer()
        : (import(/* @vite-ignore */ `${failedUrl}?retry=${++attempt}`) as Promise<M>);
    const current = run.then(pick);
    loading = current;
    current.catch((error: unknown) => {
      if (loading === current) loading = null;
      failedUrl = failedModuleUrl(error) ?? failedUrl;
    });
    return current;
  };
}

/**
 * The same-origin script URL a failed dynamic import names in its message
 * (Chromium and Firefox do; WebKit does not), without any query string.
 */
export function failedModuleUrl(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /(https?:\/\/[^\s'"?#]+\.m?js)/.exec(message);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return url.origin === window.location.origin ? url.href : null;
  } catch {
    return null;
  }
}

/** True for an error raised while downloading a view's code, not while rendering it. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}
