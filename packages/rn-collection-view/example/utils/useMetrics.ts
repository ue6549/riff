/**
 * useMetrics — live performance metrics hooks.
 *
 * useFPS(): JS-only FPS via requestAnimationFrame rolling window.
 * usePerformanceMetrics(): full metrics — native FPS (CADisplayLink),
 *   JS idle %, main-thread CPU %, memory delta, and pressure level.
 *   All native reads are synchronous JSI calls, < 1µs each.
 *   One 500ms setInterval drives all polling — minimal observer effect.
 */
import { useEffect, useRef, useState } from 'react';
import NativeCollectionViewModule from '@riff/specs/NativeCollectionViewModule';

// ── Typed nativeMod accessor (subset needed for metrics) ──────────────────────

const nativeMod = NativeCollectionViewModule as unknown as {
  metrics: {
    startFrameTimer(): void;
    stopFrameTimer(): void;
    getFrameMetrics(): { fps: number; frameTimeMs: number };
    resetMetrics(): void;
    getMainThreadCPU(): number;
  };
  memory: {
    availableBytes(): number;
    pressureLevel(): number;
  };
};

// ── useFPS (backward compat) ──────────────────────────────────────────────────

export function useFPS(): number {
  const [fps, setFps] = useState(0);
  const framesRef = useRef<number[]>([]);
  const rafRef    = useRef<number>(0);

  useEffect(() => {
    let running = true;
    let lastSetAt = 0;

    function tick(now: number) {
      if (!running) return;
      const frames = framesRef.current;
      frames.push(now);
      const cutoff = now - 1000;
      let start = 0;
      while (start < frames.length && frames[start]! < cutoff) start++;
      framesRef.current = frames.slice(start);
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

// ── usePerformanceMetrics ─────────────────────────────────────────────────────

export interface PerformanceMetrics {
  /** CADisplayLink-based FPS (main thread). 0 until first frame. */
  nativeFPS: number;
  /** Average frame duration over last ~0.5s window. */
  frameTimeMs: number;
  /** JS thread FPS via requestAnimationFrame. */
  jsFPS: number;
  /** JS thread idle headroom, 0-100. 100 = perfectly idle, 0 = every frame dropped. */
  jsIdlePct: number;
  /** Main thread CPU utilization %, 0-100. -1 if unavailable. */
  mainThreadCPU: number;
  /** Memory consumed since hook mount, in MB. Positive = consumed, negative = freed. */
  memoryDeltaMB: number;
  /** 0=normal, 1=low (<150MB available), 2=critical (<50MB available). */
  pressureLevel: number;
}

const INITIAL: PerformanceMetrics = {
  nativeFPS: 0, frameTimeMs: 0,
  jsFPS: 0, jsIdlePct: 100,
  mainThreadCPU: -1,
  memoryDeltaMB: 0, pressureLevel: 0,
};

const EXPECTED_FRAME_MS = 1000 / 60; // 16.67ms

export function usePerformanceMetrics(disabled = false): PerformanceMetrics {
  const [metrics, setMetrics] = useState<PerformanceMetrics>(INITIAL);

  // rAF idle tracker — writes to refs, never calls setState directly.
  // idleRef accumulates frame intervals in a 1s rolling window.
  // jsIdlePct = (expectedFrames / actualFrames) * 100, capped at 100.
  const rafTimestampsRef = useRef<number[]>([]);
  const rafHandleRef     = useRef<number>(0);
  const memBaselineRef   = useRef<number>(-1);

  useEffect(() => {
    if (disabled) return; // No rAF loop, no timer, no CADisplayLink — zero overhead.

    // Start CADisplayLink for native FPS.
    nativeMod.metrics.startFrameTimer();

    // Capture memory baseline on mount.
    memBaselineRef.current = nativeMod.memory.availableBytes();

    // rAF idle loop (no setState — just accumulates timestamps).
    let rafRunning = true;
    function rafTick(now: number) {
      if (!rafRunning) return;
      const ts = rafTimestampsRef.current;
      ts.push(now);
      const cutoff = now - 1000;
      let i = 0;
      while (i < ts.length && ts[i]! < cutoff) i++;
      rafTimestampsRef.current = ts.slice(i);
      rafHandleRef.current = requestAnimationFrame(rafTick);
    }
    rafHandleRef.current = requestAnimationFrame(rafTick);

    // Single 500ms polling interval — all native reads batched into one setState.
    const interval = setInterval(() => {
      const fm = nativeMod.metrics.getFrameMetrics();
      const cpu = nativeMod.metrics.getMainThreadCPU();
      const available = nativeMod.memory.availableBytes();
      const pressure = nativeMod.memory.pressureLevel();
      const baseline = memBaselineRef.current;

      // JS idle: how many frames arrived in the last second vs expected.
      const ts = rafTimestampsRef.current;
      const jsFPS = ts.length;
      const expectedFrames = 1000 / EXPECTED_FRAME_MS; // ~60
      const jsIdlePct = Math.min(100, Math.round((jsFPS / expectedFrames) * 100));

      // Memory: baseline - current (positive = consumed).
      const memoryDeltaMB = baseline >= 0
        ? Math.round(((baseline - available) / (1024 * 1024)) * 10) / 10
        : 0;

      setMetrics({
        nativeFPS:     Math.round(fm.fps),
        frameTimeMs:   Math.round(fm.frameTimeMs * 10) / 10,
        jsFPS,
        jsIdlePct,
        mainThreadCPU: cpu >= 0 ? Math.round(cpu) : -1,
        memoryDeltaMB,
        pressureLevel: pressure,
      });
    }, 500);

    return () => {
      rafRunning = false;
      cancelAnimationFrame(rafHandleRef.current);
      clearInterval(interval);
      nativeMod.metrics.stopFrameTimer();
    };
  }, [disabled]);

  return metrics;
}
