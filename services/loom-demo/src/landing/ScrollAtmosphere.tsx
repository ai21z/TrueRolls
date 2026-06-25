import { motion, useReducedMotion, useTransform } from 'framer-motion';
import { usePageScrollProgress } from './useScrollMotion';
import css from './ScrollAtmosphere.module.css';

/**
 * Scroll-driven ambient layer that replaces the hard section dividers:
 * a soft iris glow drifts and breathes as you scroll, and a thin accent
 * progress line tracks position. Reduced-motion → static glow (the progress
 * line still tracks scroll, which is direct manipulation, not autonomous motion).
 */
export function ScrollAtmosphere() {
  const reduce = useReducedMotion();
  const progress = usePageScrollProgress();

  const glowY = useTransform(progress, [0, 1], ['-8%', '34%']);
  const glowOpacity = useTransform(progress, [0, 0.5, 1], [0.55, 0.95, 0.4]);
  const hueShift = useTransform(progress, [0, 1], [0, 26]);
  const glowFilter = useTransform(hueShift, (h) => `hue-rotate(${h}deg)`);

  return (
    <>
      <div className={css.atmosphere} aria-hidden="true">
        <motion.div
          className={css.glow}
          style={reduce ? undefined : { y: glowY, opacity: glowOpacity, filter: glowFilter }}
        />
        <div className={css.grain} />
      </div>
      <motion.div className={css.progress} style={{ scaleX: progress }} aria-hidden="true" />
    </>
  );
}
