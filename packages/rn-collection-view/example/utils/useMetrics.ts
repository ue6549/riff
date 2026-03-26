/**
 * useMetrics — live performance metrics hook.
 *
 * useFPS(): measures frame rate using requestAnimationFrame over a 1-second
 * rolling window. Returns the FPS as a rounded integer.
 */
import { useEffect, useRef, useState } from 'react';

export function useFPS(): number {
  const [fps, setFps] = useState(0);
  const framesRef    = useRef<number[]>([]);
  const rafRef       = useRef<number>(0);

  useEffect(() => {
    let running = true;

    let lastSetAt = 0;

    function tick(now: number) {
      if (!running) return;
      const frames = framesRef.current;
      frames.push(now);
      // Keep only frames in the last 1 000 ms
      const cutoff = now - 1000;
      let start = 0;
      while (start < frames.length && frames[start]! < cutoff) start++;
      framesRef.current = frames.slice(start);
      // setState at most once per 500ms — avoids adding JS thread pressure
      // to the very scenario we're trying to measure.
      if (now - lastSetAt >= 500) {
        lastSetAt = now;
        setFps(framesRef.current.length);
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return fps;
}
