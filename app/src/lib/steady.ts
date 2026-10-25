/**
 * Is the phone being held still? Drives auto-capture: when the shopper holds
 * the phone steady on an item for about a second, one photo is taken
 * (approved change to tech spec 1.3; tap anywhere still works).
 */

import { Accelerometer } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';

const INTERVAL_MS = 100;
/** Change in acceleration (g) between readings that still counts as "still". */
const STILL_DELTA = 0.035;
/** How long the phone must be still before it counts as steady. */
export const STEADY_MS = 1000;
/** Movement this long re-arms auto-capture (the shopper moved to a new item). */
const MOVED_MS = 300;

export interface Steadiness {
  /** Held still for STEADY_MS. */
  steady: boolean;
  /** Increments each time the phone is clearly moved; use it to re-arm. */
  moveCount: number;
  /** False on devices without an accelerometer (e.g. the iOS Simulator). */
  available: boolean;
}

export function useSteadiness(active: boolean): Steadiness {
  const [steady, setSteady] = useState(false);
  const [moveCount, setMoveCount] = useState(0);
  const [available, setAvailable] = useState(true);
  const last = useRef<{ x: number; y: number; z: number } | null>(null);
  const stillSince = useRef<number | null>(null);
  const movingSince = useRef<number | null>(null);
  const counted = useRef(false);
  useEffect(() => {
    if (!active) return;
    last.current = null;
    stillSince.current = null;
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    Accelerometer.isAvailableAsync().then((ok) => {
      if (cancelled) return;
      setAvailable(ok);
      if (!ok) return;
      Accelerometer.setUpdateInterval(INTERVAL_MS);
      sub = Accelerometer.addListener((m) => {
        const prev = last.current;
        last.current = m;
        if (!prev) return;
        const delta = Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z);
        const now = Date.now();
        if (delta < STILL_DELTA) {
          movingSince.current = null;
          counted.current = false;
          stillSince.current ??= now;
          setSteady(now - stillSince.current >= STEADY_MS);
        } else {
          stillSince.current = null;
          setSteady(false);
          movingSince.current ??= now;
          if (!counted.current && now - movingSince.current >= MOVED_MS) {
            counted.current = true;
            setMoveCount((n) => n + 1);
          }
        }
      });
    });
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [active]);

  return { steady, moveCount, available };
}
