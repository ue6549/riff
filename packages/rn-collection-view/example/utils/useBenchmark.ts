/**
 * useBenchmark — automated scroll benchmark runner.
 *
 * Drives a scripted series of scroll runs via animated scrollToOffset,
 * samples performance metrics at 200ms intervals during each run,
 * and aggregates results into a structured BenchmarkResult.
 *
 * Scroll method: animated scrollToOffset on a ref (works for both Riff and
 * FlashList — Riff: { y, animated }, FlashList: { offset, animated }).
 *
 * Suite (7 runs, 1 warm-up + 6 measured), each measured run repeated
 * ROUNDS_PER_RUN times before moving to the next run:
 *   0. Warm-up  — scroll to bottom + back (metrics discarded)
 *   1. Slow ↓   — 20-item steps, 300ms pause between steps
 *   2. Slow ↑   — 20-item steps back to top
 *   3. Fast ↓   — 100-item steps, 200ms pause
 *   4. Fast ↑   — 100-item steps back to top
 *   5. Fling ↓  — single scroll to content bottom
 *   6. Fling ↑  — single scroll back to 0
 *
 * Fix: configRef pattern — async start() always reads configRef.current
 * so it gets the latest scrollRef/engine/liveMetrics even though the
 * BenchmarkConfig object changes on every render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PerformanceMetrics } from './useMetrics';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROUNDS_PER_RUN = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RunResult {
  name: string;
  label: string;
  rounds: number;
  avgFPS: number;
  minFPS: number;
  p5FPS: number;
  avgJSIdle: number;
  avgCPU: number;
  peakMemDeltaMB: number;
  avgBlankPct: number;
  peakBlankPct: number;
  activeMountMin: number;
  activeMountMax: number;
  durationMs: number;
}

export interface AggregateResult {
  avgFPS: number;
  minFPS: number;
  p5FPS: number;
  avgJSIdle: number;
  avgCPU: number;
  peakMemDeltaMB: number;
  avgBlankPct: number;
  peakBlankPct: number;
  totalMounts: number;
}

export interface BenchmarkResult {
  engine: string;
  tab: string;
  itemCount: number;
  itemHeight: number;
  timestamp: string;
  rounds: number;
  runs: RunResult[];
  aggregate: AggregateResult;
}

export interface BenchmarkConfig {
  /** Ref to the list component (Riff or FlashList). */
  scrollRef: React.RefObject<any>;
  /** 'riff' or 'flash' — used in result metadata and scroll method. */
  engine: 'riff' | 'flash';
  /** Tab name for result metadata ('feed' | 'search'). */
  tab: string;
  /** Total number of items in the list. */
  itemCount: number;
  /** Estimated item height in pt — used to compute step offsets. */
  itemHeight: number;
  /** Total scrollable content height. Updated from onContentSizeChange. */
  contentHeight: number;
  /** Live performance metrics from usePerformanceMetrics(). */
  liveMetrics: PerformanceMetrics;
  /** Current active mount count. */
  activeMounts: number;
  /** Current total mount count. */
  totalMounts: number;
  /** Blank area % (0-100) for Riff; -1 for FlashList (unavailable). */
  blankAreaPct: number;
}

export interface BenchmarkHandle {
  start(): void;
  isRunning: boolean;
  currentRun: string | null;
  progress: number;
  result: BenchmarkResult | null;
}

// ── Scroll helper ─────────────────────────────────────────────────────────────

function scrollToOffset(ref: React.RefObject<any>, offset: number, engine: 'riff' | 'flash') {
  if (!ref.current) return;
  if (engine === 'riff') {
    ref.current.scrollToOffset({ y: Math.max(0, offset), animated: true });
  } else {
    ref.current.scrollToOffset({ offset: Math.max(0, offset), animated: true });
  }
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p / 100 * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

// ── Run definitions ───────────────────────────────────────────────────────────

interface RunDef {
  name: string;
  label: string;
  warmup: boolean;
  /** Returns array of [offset] values to scroll to in sequence. */
  offsets(itemH: number, itemCount: number, contentH: number): number[];
  pauseMs: number;
}

function makeRuns(itemH: number, itemCount: number, contentH: number): RunDef[] {
  const bottom = contentH > 0 ? contentH : itemH * itemCount;
  const step20  = itemH * 20;
  const step100 = itemH * 100;

  function stepsDown(step: number): number[] {
    const offsets: number[] = [];
    for (let y = step; y <= bottom + step; y += step) offsets.push(Math.min(y, bottom));
    return offsets;
  }

  function stepsUp(step: number): number[] {
    const offsets: number[] = [];
    for (let y = bottom - step; y >= 0; y -= step) offsets.push(Math.max(y, 0));
    offsets.push(0);
    return offsets;
  }

  return [
    { name: 'warmup',     label: 'Warm-up',    warmup: true,  offsets: (h, n, c) => [c || h * n, 0], pauseMs: 400 },
    { name: 'slow_down',  label: 'Slow ↓ 20',  warmup: false, offsets: () => stepsDown(step20),  pauseMs: 300 },
    { name: 'slow_up',    label: 'Slow ↑ 20',  warmup: false, offsets: () => stepsUp(step20),   pauseMs: 300 },
    { name: 'fast_down',  label: 'Fast ↓ 100', warmup: false, offsets: () => stepsDown(step100), pauseMs: 200 },
    { name: 'fast_up',    label: 'Fast ↑ 100', warmup: false, offsets: () => stepsUp(step100),  pauseMs: 200 },
    { name: 'fling_down', label: 'Fling ↓',    warmup: false, offsets: (h, n, c) => [c || h * n], pauseMs: 600 },
    { name: 'fling_up',   label: 'Fling ↑',    warmup: false, offsets: () => [0],                pauseMs: 600 },
  ];
}

// ── Delay helper ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBenchmark(config: BenchmarkConfig): BenchmarkHandle {
  const [isRunning,   setIsRunning]   = useState(false);
  const [currentRun,  setCurrentRun]  = useState<string | null>(null);
  const [progress,    setProgress]    = useState(0);
  const [result,      setResult]      = useState<BenchmarkResult | null>(null);
  const abortRef   = useRef(false);

  // configRef: always holds the latest config so async start() never reads
  // stale values even though config changes every 500ms (liveMetrics update).
  const configRef = useRef(config);
  configRef.current = config;

  // Reset result when engine changes so Riff and FlashList results stay separate.
  const prevEngineRef = useRef(config.engine);
  useEffect(() => {
    if (prevEngineRef.current !== config.engine) {
      prevEngineRef.current = config.engine;
      if (!isRunning) {
        setResult(null);
        setProgress(0);
        setCurrentRun(null);
      }
    }
  });

  const start = useCallback(async () => {
    if (isRunning) return;
    setIsRunning(true);
    setResult(null);
    setProgress(0);
    abortRef.current = false;

    // Read fresh config at start — not the closure-captured config.
    const cfg = configRef.current;
    const { scrollRef, engine, tab, itemCount, itemHeight, contentHeight } = cfg;

    const runs = makeRuns(itemHeight, itemCount, contentHeight);
    const measuredRuns = runs.filter(r => !r.warmup);

    // Total steps = each measured run × its offset count × rounds.
    const totalSteps = measuredRuns.reduce(
      (sum, r) => sum + r.offsets(itemHeight, itemCount, contentHeight).length * ROUNDS_PER_RUN,
      0
    );
    let completedSteps = 0;

    const runResults: RunResult[] = [];

    for (let ri = 0; ri < runs.length; ri++) {
      if (abortRef.current) break;
      const run = runs[ri]!;
      setCurrentRun(run.label);

      // Metric samples collected across all rounds of this run.
      const fpsSamples:    number[] = [];
      const idleSamples:   number[] = [];
      const cpuSamples:    number[] = [];
      const memSamples:    number[] = [];
      const blankSamples:  number[] = [];
      let   activeMountMin = configRef.current.activeMounts;
      let   activeMountMax = configRef.current.activeMounts;
      const startTime = Date.now();

      const rounds = run.warmup ? 1 : ROUNDS_PER_RUN;

      for (let round = 0; round < rounds; round++) {
        if (abortRef.current) break;

        // Start sampling interval (200ms) for this round.
        let samplingId: ReturnType<typeof setInterval> | null = null;
        if (!run.warmup) {
          samplingId = setInterval(() => {
            // Always read from configRef.current — liveMetrics is fresh.
            const lm = configRef.current.liveMetrics;
            fpsSamples.push(lm.nativeFPS);
            idleSamples.push(lm.jsIdlePct);
            if (lm.mainThreadCPU >= 0) cpuSamples.push(lm.mainThreadCPU);
            memSamples.push(lm.memoryDeltaMB);
            const blank = configRef.current.blankAreaPct;
            if (blank >= 0) blankSamples.push(blank);
            activeMountMin = Math.min(activeMountMin, configRef.current.activeMounts);
            activeMountMax = Math.max(activeMountMax, configRef.current.activeMounts);
          }, 200);
        }

        const offsets = run.offsets(itemHeight, itemCount, contentHeight);
        for (const offset of offsets) {
          if (abortRef.current) break;
          // Always read scrollRef from configRef.current — the ref object itself
          // is stable but reading from configRef ensures we never use a stale engine.
          scrollToOffset(configRef.current.scrollRef, offset, configRef.current.engine);
          await delay(run.pauseMs);
          if (!run.warmup) {
            completedSteps++;
            setProgress(completedSteps / totalSteps);
          }
        }

        if (samplingId) clearInterval(samplingId);
      }

      if (!run.warmup && fpsSamples.length > 0) {
        runResults.push({
          name:           run.name,
          label:          run.label,
          rounds:         ROUNDS_PER_RUN,
          avgFPS:         mean(fpsSamples),
          minFPS:         Math.min(...fpsSamples),
          p5FPS:          percentile(fpsSamples, 5),
          avgJSIdle:      mean(idleSamples),
          avgCPU:         cpuSamples.length > 0 ? mean(cpuSamples) : -1,
          peakMemDeltaMB: memSamples.length > 0 ? Math.max(...memSamples) : 0,
          avgBlankPct:    blankSamples.length > 0 ? mean(blankSamples) : -1,
          peakBlankPct:   blankSamples.length > 0 ? Math.max(...blankSamples) : -1,
          activeMountMin,
          activeMountMax,
          durationMs:     Date.now() - startTime,
        });
      }
    }

    // Aggregate across all measured runs.
    const allFPS   = runResults.flatMap(r => [r.avgFPS]);
    const allIdle  = runResults.map(r => r.avgJSIdle);
    const allCPU   = runResults.filter(r => r.avgCPU >= 0).map(r => r.avgCPU);
    const allMem   = runResults.map(r => r.peakMemDeltaMB);
    const allBlank = runResults.filter(r => r.avgBlankPct >= 0).map(r => r.avgBlankPct);
    const minFPS   = runResults.reduce((m, r) => Math.min(m, r.minFPS), Infinity);
    const p5FPS    = runResults.reduce((m, r) => Math.min(m, r.p5FPS), Infinity);
    const peakBlank = runResults.filter(r => r.peakBlankPct >= 0).reduce((m, r) => Math.max(m, r.peakBlankPct), 0);

    const benchResult: BenchmarkResult = {
      engine,
      tab,
      itemCount,
      itemHeight,
      timestamp: new Date().toISOString(),
      rounds: ROUNDS_PER_RUN,
      runs: runResults,
      aggregate: {
        avgFPS:         mean(allFPS),
        minFPS:         minFPS === Infinity ? 0 : Math.round(minFPS),
        p5FPS:          p5FPS === Infinity  ? 0 : Math.round(p5FPS),
        avgJSIdle:      mean(allIdle),
        avgCPU:         allCPU.length > 0 ? mean(allCPU) : -1,
        peakMemDeltaMB: allMem.length > 0 ? Math.max(...allMem) : 0,
        avgBlankPct:    allBlank.length > 0 ? mean(allBlank) : -1,
        peakBlankPct:   allBlank.length > 0 ? peakBlank : -1,
        totalMounts:    configRef.current.totalMounts,
      },
    };

    setResult(benchResult);
    setCurrentRun(null);
    setProgress(1);
    setIsRunning(false);
  }, [isRunning]); // configRef is a ref — not a dep. Only isRunning gates re-creation.

  return { start, isRunning, currentRun, progress, result };
}
