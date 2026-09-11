import { useEffect, useRef, useState } from 'react';

const CLOSE_ANIMATION_MS = 150; // matches index.css's `.dropdown-panel` transition duration

/**
 * Keeps a dropdown/menu panel mounted for one animation cycle after `open`
 * goes false, so closing actually fades + slides out instead of the element
 * just vanishing. Pass the returned `dataState` straight to the panel's
 * `data-state` attribute — `.dropdown-panel` in index.css owns the actual
 * opacity/transform values for each state.
 */
export function useDropdownPanel(open) {
  const [rendered, setRendered] = useState(false);
  const [entered, setEntered] = useState(false);
  const closeTimer = useRef(null);

  useEffect(() => {
    clearTimeout(closeTimer.current);
    if (open) {
      setRendered(true);
      // Mount in the closed visual state first, then flip to open on the
      // next frame — flipping in the same tick as mounting would leave the
      // browser nothing to transition from, so it'd just pop in instead of
      // animating.
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    closeTimer.current = setTimeout(() => setRendered(false), CLOSE_ANIMATION_MS);
    return () => clearTimeout(closeTimer.current);
  }, [open]);

  return { rendered, dataState: entered ? 'open' : 'closed' };
}
