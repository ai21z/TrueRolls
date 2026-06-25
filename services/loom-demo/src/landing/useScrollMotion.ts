import { useEffect } from 'react';
import { useMotionValue, useSpring } from 'framer-motion';

/**
 * Page scroll progress (0 → 1) as a smoothed MotionValue, driven directly from
 * `window.scrollY`. We read the scroll position ourselves instead of relying on
 * framer's `useScroll()` auto-measurement, which mis-measures when page height
 * changes after mount (the lazy 3D chunk) and inside embedded/iframe contexts.
 */
export function usePageScrollProgress() {
  const raw = useMotionValue(0);

  useEffect(() => {
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      raw.set(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // Re-measure once the lazy hero chunk has changed the page height.
    const settle = window.setTimeout(update, 900);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.clearTimeout(settle);
    };
  }, [raw]);

  return useSpring(raw, { stiffness: 120, damping: 30, mass: 0.3 });
}
