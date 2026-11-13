/*
  Motion tokens (seconds, for the motion library). The same values exist as CSS variables in index.css.
  Interface changes stay within 150-300 ms, ease out on entry, never bounce (brief section 7).
  Reduced motion: <MotionConfig reducedMotion="user"> in main.tsx turns transforms off app-wide;
  opacity fades remain.
*/
export const duration = { fast: 0.15, base: 0.22, slow: 0.3 } as const;
export const easeOut = [0.22, 1, 0.36, 1] as const;

export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: duration.base, ease: easeOut },
};

export const riseIn = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: duration.base, ease: easeOut },
};

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
