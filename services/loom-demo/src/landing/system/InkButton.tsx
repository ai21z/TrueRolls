import { type ButtonHTMLAttributes } from 'react';
import { InkFrame } from './InkFrame';

/**
 * InkButton - a button whose border is drawn by hand. Wraps a real <button> in an
 * inline InkFrame so the element stays a focusable, interactive button (its
 * :focus-visible ring and hover still work); only the border becomes inked.
 *
 * Set the ink colour by passing a frameClassName that sets --ink-stroke
 * (e.g. an .inkFail / .inkAccent helper), or leave it to default --nec-node.
 */
interface InkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  seed?: number;
  /** inline-block (default) vs block (for full-width buttons). */
  inline?: boolean;
  /** class on the InkFrame wrapper, e.g. to set --ink-stroke or full width. */
  frameClassName?: string;
}

export function InkButton({ seed, inline = true, frameClassName, children, ...rest }: InkButtonProps) {
  return (
    <InkFrame inline={inline} seed={seed} className={frameClassName}>
      <button {...rest}>{children}</button>
    </InkFrame>
  );
}
