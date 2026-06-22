/**
 * PerfHood — rich live performance overlay + automated benchmark runner.
 *
 * Live display (7 metric rows):
 *   UI  — CADisplayLink native FPS + frame time
 *   JS  — rAF FPS + idle headroom %
 *   CPU — main-thread utilization % (Mach thread_info)
 *   Cells — active / total mount count
 *   Mem — memory delta from session start
 *   Blank — % of viewport showing no cell content (Riff only; — for FlashList)
 *   Vel — scroll velocity (when scrolling)
 *
 * Benchmark mode (tap "▶ Bench"):
 *   Runs a scripted scroll suite (warm-up + 6 measured runs × 5 rounds each),
 *   samples metrics at 200ms intervals, displays a full summary table:
 *   Run | UI fps | Min | p5 | JS% | CPU | Mem | Blank
 *   "Copy JSON" produces structured output for LLM comparison analysis.
 *
 * Color coding: green/yellow/red per metric threshold.
 * The overlay intercepts touch only for the benchmark button and summary
 * close/copy buttons. All other areas pass touches through.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePerformanceMetrics } from '../utils/useMetrics';
import { useBenchmark } from '../utils/useBenchmark';
import type { AggregateResult, BenchmarkConfig, BenchmarkResult, RunResult } from '../utils/useBenchmark';

// ── Public props ──────────────────────────────────────────────────────────────

export interface PerfHoodProps {
  /** When true, the 500ms metrics timer is stopped. PerfHood stays mounted
   *  with static/stale values but adds zero overhead. Use RN's built-in
   *  perf monitor for JS FPS measurement instead. */
  disabled?: boolean;
  /**
   * Getter for currently mounted cell count.
   * Called on PerfHood's own 500ms tick — does NOT cause the list parent to re-render.
   */
  getActiveMounts: () => number;
  /** Getter for total cells ever mounted (cumulative). */
  getTotalMounts: () => number;
  /** Getter for scroll velocity in pt/s. Called on PerfHood's own 500ms tick. */
  getScrollVelocity?: () => number;
  /**
   * Getter for blank area % (0-100, or -1 if unavailable).
   * Called on PerfHood's own tick.
   */
  getBlankAreaPct?: () => number;
  // ── Benchmark config (optional — omit to disable "▶ Bench" button) ──
  scrollRef?: React.RefObject<any>;
  engine?: 'riff' | 'flash';
  tab?: string;
  itemCount?: number;
  itemHeight?: number;
  /** Getter for content height. Called on PerfHood's own 500ms tick. */
  getContentHeight?: () => number;
  // ── Cross-section recycling toggle (optional — omit to disable button) ──
  /** Current state of cross-section recycling on the Riff instance. */
  crossSectionRecycling?: boolean;
  /** Called when user taps the X-Recycle toggle. */
  onToggleCrossSectionRecycling?: () => void;
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function fpsColor(fps: number)      { return fps >= 55 ? '#4ade80' : fps >= 40 ? '#facc15' : '#f87171'; }
function idleColor(pct: number)     { return pct >= 70 ? '#4ade80' : pct >= 40 ? '#facc15' : '#f87171'; }
function cpuColor(pct: number)      { return pct < 0 ? '#555' : pct < 50 ? '#4ade80' : pct < 80 ? '#facc15' : '#f87171'; }
function memColor(mb: number)       { return mb < 20 ? '#4ade80' : mb < 50 ? '#facc15' : '#f87171'; }
function blankColor(pct: number)    { return pct <= 2 ? '#4ade80' : pct <= 10 ? '#facc15' : '#f87171'; }

// ── Cross-engine result storage (module-level, survives engine switch) ────────

const storedResults: Record<string, BenchmarkResult> = {};

// ── Comparison scorecard ─────────────────────────────────────────────────────

type ScorecardRow = { label: string; riff: string; flash: string; winner: string };

function buildScorecard(riff: AggregateResult, flash: AggregateResult): ScorecardRow[] {
  const rows: ScorecardRow[] = [];
  const add = (label: string, rv: number, fv: number, fmt: (v: number) => string, lower: boolean) => {
    const diff = Math.abs(rv - fv);
    const threshold = Math.max(Math.abs(rv), Math.abs(fv)) * 0.05; // 5% tolerance
    let winner: string;
    if (diff <= threshold) {
      winner = 'Tied';
    } else if (lower ? rv < fv : rv > fv) {
      const ratio = fv > 0 ? rv / fv : 0;
      const invRatio = rv > 0 ? fv / rv : 0;
      const r = lower ? invRatio : ratio;
      winner = r >= 1.5 ? `Riff ${r.toFixed(1)}x` : 'Riff';
    } else {
      const ratio = rv > 0 ? fv / rv : 0;
      const invRatio = fv > 0 ? rv / fv : 0;
      const r = lower ? invRatio : ratio;
      winner = r >= 1.5 ? `Flash ${r.toFixed(1)}x` : 'Flash';
    }
    rows.push({ label, riff: fmt(rv), flash: fmt(fv), winner });
  };

  const pct = (v: number) => `${v}%`;
  const fps = (v: number) => `${v}`;
  const mb = (v: number) => `${v.toFixed(1)} MB`;
  const n = (v: number) => `${v}`;

  add('Avg FPS',      riff.avgFPS,          flash.avgFPS,          fps, false);
  add('Min FPS',      riff.minFPS,          flash.minFPS,          fps, false);
  add('p5 FPS',       riff.p5FPS,           flash.p5FPS,           fps, false);
  add('JS Idle',      riff.avgJSIdle,       flash.avgJSIdle,       pct, false);
  add('Avg CPU',      riff.avgCPU,          flash.avgCPU,          pct, true);
  add('p75 CPU',      riff.p75CPU,          flash.p75CPU,          pct, true);
  add('p90 CPU',      riff.p90CPU,          flash.p90CPU,          pct, true);
  add('Avg Mem',      riff.avgMemDeltaMB,   flash.avgMemDeltaMB,   mb,  true);
  add('p75 Mem',      riff.p75MemDeltaMB,   flash.p75MemDeltaMB,   mb,  true);
  add('p90 Mem',      riff.p90MemDeltaMB,   flash.p90MemDeltaMB,   mb,  true);
  add('Peak Mem',     riff.peakMemDeltaMB,  flash.peakMemDeltaMB,  mb,  true);
  add('Active Avg',   riff.activeMountAvg,  flash.activeMountAvg,  n,   true);
  add('Active p75',   riff.activeMountP75,  flash.activeMountP75,  n,   true);
  add('Active Peak',  riff.activeMountMax,  flash.activeMountMax,  n,   true);
  add('Total Mounts', riff.totalMounts,     flash.totalMounts,     n,   true);

  return rows;
}

function ComparisonScorecard({ riffResult, flashResult }: { riffResult: BenchmarkResult; flashResult: BenchmarkResult }) {
  const rows = buildScorecard(riffResult.aggregate, flashResult.aggregate);
  const riffWins = rows.filter(r => r.winner.startsWith('Riff')).length;
  const flashWins = rows.filter(r => r.winner.startsWith('Flash')).length;
  const tied = rows.filter(r => r.winner === 'Tied').length;

  const handleCopy = async () => {
    const comparison = {
      riff: riffResult,
      flash: flashResult,
      scorecard: rows,
      summary: { riffWins, flashWins, tied },
    };
    await Share.share({ message: JSON.stringify(comparison, null, 2) });
  };

  return (
    <View style={C.container}>
      <Text style={C.heading}>COMPARISON SCORECARD</Text>
      <Text style={C.sub}>Riff {riffWins} · Flash {flashWins} · Tied {tied}</Text>

      {/* Header */}
      <View style={C.headerRow}>
        <Text style={[C.th, { width: 80, textAlign: 'left' }]}>Metric</Text>
        <Text style={[C.th, { width: 62 }]}>Riff</Text>
        <Text style={[C.th, { width: 62 }]}>Flash</Text>
        <Text style={[C.th, { width: 76, textAlign: 'left', paddingLeft: 6 }]}>Winner</Text>
      </View>

      {/* Rows */}
      <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
        {rows.map((r) => {
          const winColor = r.winner.startsWith('Riff') ? '#4ade80'
            : r.winner.startsWith('Flash') ? '#60a5fa'
            : '#555';
          return (
            <View key={r.label} style={C.row}>
              <Text style={[C.cell, { width: 80, textAlign: 'left', color: '#888' }]}>{r.label}</Text>
              <Text style={[C.cell, { width: 62, color: r.winner.startsWith('Riff') ? '#4ade80' : '#ccc' }]}>{r.riff}</Text>
              <Text style={[C.cell, { width: 62, color: r.winner.startsWith('Flash') ? '#60a5fa' : '#ccc' }]}>{r.flash}</Text>
              <Text style={[C.cell, { width: 76, textAlign: 'left', paddingLeft: 6, color: winColor, fontWeight: '700' }]}>{r.winner}</Text>
            </View>
          );
        })}
      </ScrollView>

      <Pressable style={C.copyBtn} onPress={handleCopy}>
        <Text style={C.copyText}>Copy Comparison JSON</Text>
      </Pressable>
    </View>
  );
}

const C = StyleSheet.create({
  container: { marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2a2a2a', paddingTop: 8 },
  heading:   { fontSize: 12, fontWeight: '700', color: '#facc15', fontFamily: 'Menlo' },
  sub:       { fontSize: 10, color: '#666', fontFamily: 'Menlo', marginBottom: 4 },
  headerRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a2a', paddingBottom: 3 },
  th:        { fontSize: 9, fontWeight: '600', color: '#444', fontFamily: 'Menlo', textAlign: 'right' },
  row:       { flexDirection: 'row', paddingVertical: 2.5 },
  cell:      { fontSize: 10, color: '#ccc', fontFamily: 'Menlo', textAlign: 'right' },
  copyBtn:   { marginTop: 6, paddingVertical: 6, backgroundColor: '#1a1a1a', borderRadius: 5, alignItems: 'center' },
  copyText:  { fontSize: 10, fontWeight: '600', color: '#facc15', fontFamily: 'Menlo' },
});

// ── Benchmark summary modal ───────────────────────────────────────────────────

function BenchmarkSummary({
  result,
  otherResult,
  onClose,
  onRunAgain,
}: {
  result: BenchmarkResult;
  otherResult: BenchmarkResult | null;
  onClose: () => void;
  onRunAgain: () => void;
}) {
  const handleCopyJSON = async () => {
    await Share.share({ message: JSON.stringify(result, null, 2) });
  };

  const riffResult = result.engine === 'riff' ? result : otherResult;
  const flashResult = result.engine === 'flash' ? result : otherResult;

  const agg = result.aggregate;
  const hasBlank = agg.avgBlankPct >= 0;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={M.backdrop}>
        <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={{ flexGrow: 0 }}>
          <View style={M.sheet}>
          <Text style={M.title}>BENCHMARK — {result.engine.toUpperCase()} · {result.tab}</Text>
          <Text style={M.subtitle}>{result.itemCount} items · {result.rounds}×/run · {result.timestamp.slice(11, 19)} UTC</Text>

          {/* Per-run table — horizontally scrollable for all 7 columns */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {/* Header */}
              <View style={M.tableHeader}>
                <Text style={[M.th, { width: 68 }]}>Run</Text>
                <Text style={[M.th, { width: 34 }]}>FPS</Text>
                <Text style={[M.th, { width: 30 }]}>Min</Text>
                <Text style={[M.th, { width: 30 }]}>p5</Text>
                <Text style={[M.th, { width: 34 }]}>JS%</Text>
                <Text style={[M.th, { width: 34 }]}>CPU</Text>
                <Text style={[M.th, { width: 34 }]}>Cp75</Text>
                <Text style={[M.th, { width: 34 }]}>Cp90</Text>
                <Text style={[M.th, { width: 40 }]}>Mem</Text>
                <Text style={[M.th, { width: 40 }]}>Mp75</Text>
                <Text style={[M.th, { width: 40 }]}>Mp90</Text>
                <Text style={[M.th, { width: 40 }]}>MPk</Text>
                <Text style={[M.th, { width: 32 }]}>Cel</Text>
                <Text style={[M.th, { width: 32 }]}>C75</Text>
                <Text style={[M.th, { width: 32 }]}>CPk</Text>
                {hasBlank && <Text style={[M.th, { width: 38 }]}>Blnk</Text>}
              </View>

              {/* Per-run rows */}
              <ScrollView style={M.tableScroll} showsVerticalScrollIndicator={false}>
                {result.runs.map((r: RunResult) => (
                  <View key={r.name} style={M.tableRow}>
                    <Text style={[M.td, { width: 68 }]} numberOfLines={1}>{r.label}</Text>
                    <Text style={[M.td, { width: 34, color: fpsColor(r.avgFPS) }]}>{r.avgFPS}</Text>
                    <Text style={[M.td, { width: 30, color: fpsColor(r.minFPS) }]}>{r.minFPS}</Text>
                    <Text style={[M.td, { width: 30, color: fpsColor(r.p5FPS) }]}>{r.p5FPS}</Text>
                    <Text style={[M.td, { width: 34, color: idleColor(r.avgJSIdle) }]}>{r.avgJSIdle}%</Text>
                    <Text style={[M.td, { width: 34, color: cpuColor(r.avgCPU) }]}>{r.avgCPU >= 0 ? `${r.avgCPU}%` : '—'}</Text>
                    <Text style={[M.td, { width: 34, color: cpuColor(r.p75CPU) }]}>{r.p75CPU >= 0 ? `${r.p75CPU}%` : '—'}</Text>
                    <Text style={[M.td, { width: 34, color: cpuColor(r.p90CPU) }]}>{r.p90CPU >= 0 ? `${r.p90CPU}%` : '—'}</Text>
                    <Text style={[M.td, { width: 40, color: memColor(r.avgMemDeltaMB) }]}>+{r.avgMemDeltaMB.toFixed(1)}</Text>
                    <Text style={[M.td, { width: 40, color: memColor(r.p75MemDeltaMB) }]}>+{r.p75MemDeltaMB.toFixed(1)}</Text>
                    <Text style={[M.td, { width: 40, color: memColor(r.p90MemDeltaMB) }]}>+{r.p90MemDeltaMB.toFixed(1)}</Text>
                    <Text style={[M.td, { width: 40, color: memColor(r.peakMemDeltaMB) }]}>+{r.peakMemDeltaMB.toFixed(1)}</Text>
                    <Text style={[M.td, { width: 32 }]}>{r.activeMountAvg}</Text>
                    <Text style={[M.td, { width: 32 }]}>{r.activeMountP75}</Text>
                    <Text style={[M.td, { width: 32 }]}>{r.activeMountMax}</Text>
                    {hasBlank && (
                      <Text style={[M.td, { width: 38, color: r.avgBlankPct >= 0 ? blankColor(r.avgBlankPct) : '#555' }]}>
                        {r.avgBlankPct >= 0 ? `${r.avgBlankPct}%` : '—'}
                      </Text>
                    )}
                  </View>
                ))}
              </ScrollView>

              {/* Aggregate row */}
              <View style={M.aggRow}>
                <Text style={[M.aggLabel, { width: 68 }]}>TOTAL</Text>
                <Text style={[M.aggVal, { width: 34, color: fpsColor(agg.avgFPS) }]}>{agg.avgFPS}</Text>
                <Text style={[M.aggVal, { width: 30, color: fpsColor(agg.minFPS) }]}>{agg.minFPS}</Text>
                <Text style={[M.aggVal, { width: 30, color: fpsColor(agg.p5FPS) }]}>{agg.p5FPS}</Text>
                <Text style={[M.aggVal, { width: 34, color: idleColor(agg.avgJSIdle) }]}>{agg.avgJSIdle}%</Text>
                <Text style={[M.aggVal, { width: 34, color: cpuColor(agg.avgCPU) }]}>{agg.avgCPU >= 0 ? `${agg.avgCPU}%` : '—'}</Text>
                <Text style={[M.aggVal, { width: 34, color: cpuColor(agg.p75CPU) }]}>{agg.p75CPU >= 0 ? `${agg.p75CPU}%` : '—'}</Text>
                <Text style={[M.aggVal, { width: 34, color: cpuColor(agg.p90CPU) }]}>{agg.p90CPU >= 0 ? `${agg.p90CPU}%` : '—'}</Text>
                <Text style={[M.aggVal, { width: 40, color: memColor(agg.avgMemDeltaMB) }]}>+{agg.avgMemDeltaMB.toFixed(1)}</Text>
                <Text style={[M.aggVal, { width: 40, color: memColor(agg.p75MemDeltaMB) }]}>+{agg.p75MemDeltaMB.toFixed(1)}</Text>
                <Text style={[M.aggVal, { width: 40, color: memColor(agg.p90MemDeltaMB) }]}>+{agg.p90MemDeltaMB.toFixed(1)}</Text>
                <Text style={[M.aggVal, { width: 40, color: memColor(agg.peakMemDeltaMB) }]}>+{agg.peakMemDeltaMB.toFixed(1)}</Text>
                <Text style={[M.aggVal, { width: 32 }]}>{agg.activeMountAvg}</Text>
                <Text style={[M.aggVal, { width: 32 }]}>{agg.activeMountP75}</Text>
                <Text style={[M.aggVal, { width: 32 }]}>{agg.activeMountMax}</Text>
                {hasBlank && (
                  <Text style={[M.aggVal, { width: 38, color: agg.avgBlankPct >= 0 ? blankColor(agg.avgBlankPct) : '#555' }]}>
                    {agg.avgBlankPct >= 0 ? `${agg.avgBlankPct}%` : '—'}
                  </Text>
                )}
              </View>
            </View>
          </ScrollView>

          {/* Extra stats */}
          <Text style={M.extraStats}>
            {'CPU avg/p75/p90: '}{agg.avgCPU >= 0 ? `${agg.avgCPU}/${agg.p75CPU}/${agg.p90CPU}%` : '—'}
            {'  ·  Mem avg/p75/p90/pk: '}{`${agg.avgMemDeltaMB.toFixed(1)}/${agg.p75MemDeltaMB.toFixed(1)}/${agg.p90MemDeltaMB.toFixed(1)}/${agg.peakMemDeltaMB.toFixed(1)}M`}
            {'\n'}{'Cells avg/p75/pk: '}{`${agg.activeMountAvg}/${agg.activeMountP75}/${agg.activeMountMax}`}{'  ·  total '}{agg.totalMounts}
            {hasBlank && agg.peakBlankPct >= 0 ? `  ·  peak blank ${agg.peakBlankPct}%` : ''}
          </Text>

          {/* Action buttons */}
          <View style={M.btnRow}>
            <Pressable style={M.btn} onPress={onClose}>
              <Text style={M.btnText}>Close</Text>
            </Pressable>
            <Pressable style={[M.btn, M.btnAccent]} onPress={onRunAgain}>
              <Text style={[M.btnText, { color: '#4ade80' }]}>Run Again</Text>
            </Pressable>
            <Pressable style={[M.btn, M.btnAccent]} onPress={handleCopyJSON}>
              <Text style={[M.btnText, { color: '#60a5fa' }]}>Copy JSON</Text>
            </Pressable>
          </View>

          {/* Comparison scorecard — shown when both engines have been benchmarked */}
          {riffResult && flashResult && (
            <ComparisonScorecard riffResult={riffResult} flashResult={flashResult} />
          )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PerfHood({
  disabled = false,
  getActiveMounts,
  getTotalMounts,
  getScrollVelocity,
  getBlankAreaPct,
  scrollRef,
  engine = 'riff',
  tab = 'feed',
  itemCount = 0,
  itemHeight = 56,
  getContentHeight,
  crossSectionRecycling,
  onToggleCrossSectionRecycling,
}: PerfHoodProps) {
  const m = usePerformanceMetrics(disabled);
  const insets = useSafeAreaInsets();
  const [showResult, setShowResult] = useState(false);
  const prevResultRef = useRef<BenchmarkResult | null>(null);

  // Read all metrics on our own 500ms tick — no list parent re-render needed.
  const [activeMounts, setActiveMounts] = useState(0);
  const [totalMounts,  setTotalMounts]  = useState(0);
  const [blankAreaPct, setBlankAreaPct] = useState(-1);
  const [scrollVelocity, setScrollVelocity] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  useEffect(() => {
    if (disabled) return;
    const id = setInterval(() => {
      setActiveMounts(getActiveMounts());
      setTotalMounts(getTotalMounts());
      setBlankAreaPct(getBlankAreaPct?.() ?? -1);
      setScrollVelocity(getScrollVelocity?.() ?? 0);
      setContentHeight(getContentHeight?.() ?? 0);
    }, 500);
    return () => clearInterval(id);
  // Getters are stable useCallback refs — safe to omit from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  const benchmarkEnabled = !!scrollRef;

  const benchConfig: BenchmarkConfig = {
    scrollRef: scrollRef ?? { current: null },
    engine,
    tab,
    itemCount,
    itemHeight,
    contentHeight,
    liveMetrics: m,
    getActiveMounts,
    getTotalMounts,
    getBlankAreaPct: getBlankAreaPct ?? (() => -1),
  };

  const bench = useBenchmark(benchConfig);

  // Auto-show summary when a new result arrives; store for cross-engine comparison.
  useEffect(() => {
    if (bench.result && bench.result !== prevResultRef.current) {
      prevResultRef.current = bench.result;
      storedResults[bench.result.engine] = bench.result;
      setShowResult(true);
    } else if (!bench.result) {
      prevResultRef.current = null;
      setShowResult(false);
    }
  }, [bench.result]);

  const handleBenchPress = () => {
    if (bench.isRunning) return;
    if (bench.result) {
      setShowResult(true);
    } else {
      bench.start();
    }
  };

  const handleRunAgain = () => {
    setShowResult(false);
    bench.start();
  };

  const velStr = scrollVelocity > 5
    ? scrollVelocity >= 1000
      ? `${(scrollVelocity / 1000).toFixed(1)}k`
      : `${Math.round(scrollVelocity)}`
    : null;

  return (
    <>
      {/* Result modal */}
      {showResult && bench.result && (
        <BenchmarkSummary
          result={bench.result}
          otherResult={storedResults[engine === 'riff' ? 'flash' : 'riff'] ?? null}
          onClose={() => setShowResult(false)}
          onRunAgain={handleRunAgain}
        />
      )}

      <View style={[S.overlay, { bottom: 16 + insets.bottom }]} pointerEvents="box-none">
        {/* Metric rows (no touch interception) */}
        <View pointerEvents="none">
          {/* UI (native CADisplayLink) FPS */}
          <View style={S.row}>
            <Text style={S.label}>UI </Text>
            <Text style={[S.val, { color: fpsColor(m.nativeFPS) }]}>{m.nativeFPS}</Text>
            <Text style={S.unit}>fps </Text>
            <Text style={S.dim}>{m.frameTimeMs.toFixed(1)}ms</Text>
          </View>

          {/* JS thread FPS + idle */}
          <View style={S.row}>
            <Text style={S.label}>JS </Text>
            <Text style={[S.val, { color: fpsColor(m.jsFPS) }]}>{m.jsFPS}</Text>
            <Text style={S.unit}>fps </Text>
            <Text style={S.dim}>idle </Text>
            <Text style={[S.val, { color: idleColor(m.jsIdlePct) }]}>{m.jsIdlePct}</Text>
            <Text style={S.unit}>%</Text>
          </View>

          {/* Main thread CPU */}
          <View style={S.row}>
            <Text style={S.label}>CPU </Text>
            {m.mainThreadCPU >= 0 ? (
              <>
                <Text style={[S.val, { color: cpuColor(m.mainThreadCPU) }]}>{m.mainThreadCPU}</Text>
                <Text style={S.unit}>%</Text>
              </>
            ) : (
              <Text style={S.dim}>—</Text>
            )}
          </View>

          {/* Active / total mounts */}
          <View style={S.row}>
            <Text style={S.label}>Cells </Text>
            <Text style={S.val}>{activeMounts}</Text>
            <Text style={S.dim}>/{totalMounts}</Text>
          </View>

          {/* Memory delta */}
          <View style={S.row}>
            <Text style={S.label}>Mem </Text>
            <Text style={[S.val, { color: memColor(Math.abs(m.memoryDeltaMB)) }]}>
              {m.memoryDeltaMB >= 0 ? '+' : ''}{m.memoryDeltaMB.toFixed(1)}
            </Text>
            <Text style={S.unit}> MB</Text>
            {m.pressureLevel > 0 && (
              <Text style={[S.unit, { color: m.pressureLevel === 2 ? '#f87171' : '#facc15' }]}>
                {' '}{m.pressureLevel === 2 ? '⚠' : '△'}
              </Text>
            )}
          </View>

          {/* Blank area */}
          <View style={S.row}>
            <Text style={S.label}>Blank </Text>
            {blankAreaPct >= 0 ? (
              <>
                <Text style={[S.val, { color: blankColor(blankAreaPct) }]}>{blankAreaPct}</Text>
                <Text style={S.unit}>%</Text>
              </>
            ) : (
              <Text style={S.dim}>—</Text>
            )}
          </View>

          {/* Scroll velocity */}
          {velStr != null && (
            <View style={S.row}>
              <Text style={S.label}>Vel </Text>
              <Text style={S.val}>{velStr}</Text>
              <Text style={S.unit}> pt/s</Text>
            </View>
          )}
        </View>

        {/* Cross-section recycling toggle.
            Shows current state. Tap to flip. Migration is non-destructive
            (SlotManager.setCrossSectionRecycling preserves slot keys), so
            the bench can be run twice in succession — once each state —
            without restarting the app. */}
        {onToggleCrossSectionRecycling != null && (
          <Pressable style={S.toggleBtn} onPress={onToggleCrossSectionRecycling}>
            <Text style={S.toggleText} numberOfLines={1}>
              X-Recycle: {crossSectionRecycling ? 'ON' : 'OFF'}
            </Text>
          </Pressable>
        )}

        {/* Benchmark button / progress */}
        {benchmarkEnabled && (
          <Pressable style={S.benchBtn} onPress={handleBenchPress}>
            {bench.isRunning ? (
              <Text style={S.benchText} numberOfLines={1}>
                {bench.currentRun ?? '…'} {Math.round(bench.progress * 100)}%
              </Text>
            ) : bench.result ? (
              <Text style={S.benchText}>▶ Results</Text>
            ) : (
              <Text style={S.benchText}>▶ Bench</Text>
            )}
          </Pressable>
        )}
      </View>
    </>
  );
}

// ── Overlay styles ────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  overlay: {
    position: 'absolute',
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.82)',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    gap: 3,
    minWidth: 148,
  },
  row:      { flexDirection: 'row', alignItems: 'baseline' },
  label:    { fontSize: 10, color: '#555', fontFamily: 'Menlo', width: 38 },
  val:      { fontSize: 11, fontWeight: '700', color: '#ddd', fontFamily: 'Menlo' },
  unit:     { fontSize: 10, color: '#555', fontFamily: 'Menlo' },
  dim:      { fontSize: 10, color: '#444', fontFamily: 'Menlo' },
  benchBtn: {
    marginTop: 5,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#1a1a1a',
    borderRadius: 5,
    alignItems: 'center',
  },
  benchText: { fontSize: 10, color: '#4ade80', fontWeight: '700', fontFamily: 'Menlo' },
  toggleBtn: {
    marginTop: 5,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: '#1a1a1a',
    borderRadius: 5,
    alignItems: 'center',
  },
  toggleText: { fontSize: 9, color: '#fbbf24', fontWeight: '700', fontFamily: 'Menlo' },
});

// ── Modal styles ──────────────────────────────────────────────────────────────

const M = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  sheet: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2a2a2a',
  },
  title:    { fontSize: 13, fontWeight: '700', color: '#4ade80', fontFamily: 'Menlo' },
  subtitle: { fontSize: 10, color: '#555', fontFamily: 'Menlo', marginTop: -4 },

  tableHeader: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a2a', paddingBottom: 4 },
  th:          { fontSize: 9, fontWeight: '600', color: '#444', fontFamily: 'Menlo', textAlign: 'right' },
  tableScroll: { maxHeight: 180 },
  tableRow:    { flexDirection: 'row', paddingVertical: 3 },
  td:          { fontSize: 11, color: '#ccc', fontFamily: 'Menlo', textAlign: 'right' },

  aggRow:   { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2a2a2a', paddingTop: 4, marginTop: -4 },
  aggLabel: { fontSize: 11, fontWeight: '700', color: '#888', fontFamily: 'Menlo', textAlign: 'right' },
  aggVal:   { fontSize: 11, fontWeight: '700', fontFamily: 'Menlo', textAlign: 'right' },

  extraStats: { fontSize: 10, color: '#555', fontFamily: 'Menlo' },

  btnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  btn:    { flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: '#1a1a1a', alignItems: 'center' },
  btnAccent: { backgroundColor: '#1a1a1a' },
  btnText:   { fontSize: 11, fontWeight: '600', color: '#888', fontFamily: 'Menlo' },
});
