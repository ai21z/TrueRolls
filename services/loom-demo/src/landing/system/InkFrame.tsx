import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { inkRect } from './ink';
import css from './InkFrame.module.css';

/**
 * InkFrame, a hand-drawn border for any HTML box, card, button, or cell.
 *
 * Measures itself and lays an inked rectangle (two passes via inkRect) over its own
 * edges. The ink is aria-hidden and pointer-events:none, so the wrapped content stays
 * crisp and fully interactive. This is the one mechanism that makes every border on
 * the site read as the same hand. Replace an element's CSS `border` with an InkFrame.
 */

interface InkFrameProps extends HTMLAttributes<HTMLSpanElement> {
  /** Seed the pen jitter so a given box is stable but no two are identical. */
  seed?: number;
  /** inline-block (buttons, chips) vs block (panels, cards). */
  inline?: boolean;
  children: ReactNode;
}

export function InkFrame({ seed = 1, inline = false, className, children, ...rest }: InkFrameProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [d, setD] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setD((prev) => {
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
    };
    measure(); // immediate, so the border paints on first layout
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <span ref={ref} className={`${inline ? css.inline : css.block} ${className ?? ''}`} {...rest}>
      {d.w > 1 && d.h > 1 && (
        <svg
          className={css.ink}
          width={d.w}
          height={d.h}
          viewBox={`0 0 ${d.w} ${d.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className={css.pass1} d={inkRect(d.w, d.h, seed)} />
          <path className={css.pass2} d={inkRect(d.w, d.h, seed + 7)} />
        </svg>
      )}
      {children}
    </span>
  );
}
