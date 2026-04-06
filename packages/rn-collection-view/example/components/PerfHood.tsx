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
import { usePerformanceMetrics } from '../utils/useMetrics';
import { useBenchmark } from '../utils/useBenchmark';
import type { BenchmarkConfig, BenchmarkResult, RunResult } from '../utils/useBenchmark';

// ── Public props ──────────────────────────────────────────────────────────────

export interface PerfHoodProps {
  /** Currently mounted cell count (decremented on unmount). */
  activeMounts: number;
  /** Total cells ever mounted (cumulative). */
  totalMounts: number;
  /** Scroll velocity in pt/s from the parent's onScroll handler. */
  scrollVelocity?: number;
  /** Blank area % (0-100) from Riff's onBlankArea; -1 = unavailable (FlashList). */
  blankAreaPct?: number;
  // ── Benchmark config (optional — omit to disable "▶ Bench" button) ──
  scrollRef?: React.RefObject<any>;
  engine?: 'riff' | 'flash';
  tab?: string;
  itemCount?: number;
  itemHeight?: number;
  contentHeight?: number;
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function fpsColor(fps: number)      { return fps >= 55 ? '#4ade80' : fps >= 40 ? '#facc15' : '#f87171'; }
function idleColor(pct: number)     { return pct >= 70 ? '#4ade80' : pct >= 40 ? '#facc15' : '#f87171'; }
function cpuColor(pct: number)      { return pct < 0 ? '#555' : pct < 50 ? '#4ade80' : pct < 80 ? '#facc15' : '#f87171'; }
function memColor(mb: number)       { return mb < 20 ? '#4ade80' : mb < 50 ? '#facc15' : '#f87171'; }
function blankColor(pct: number)    { return pct <= 2 ? '#4ade80' : pct <= 10 ? '#facc15' : '#f87171'; }

// ── Benchmark summary modal ───────────────────────────────────────────────────

function BenchmarkSummary({
  result,
  onClose,
  onRunAgain,
}: {
  result: BenchmarkResult;
  onClose: () => void;
  onRunAgain: () => void;
}) {
  const handleCopyJSON = async () => {
    await Share.share({ message: JSON.stringify(result, null, 2) });
  };

  const agg = result.aggregate;
  const hasBlank = agg.avgBlankPct >= 0;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={M.backdrop}>
        <View style={M.sheet}>
          <Text style={M.title}>BENCHMARK — {result.engine.toUpperCase()} · {result.tab}</Text>
          <Text style={M.subtitle}>{result.itemCount} items · {result.rounds}×/run · {result.timestamp.slice(11, 19)} UTC</Text>

          {/* Per-run table — horizontally scrollable for all 7 columns */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {/* Header */}
              <View style={M.tableHeader}>
                <Text style={[M.th, { width: 68 }]}>Run</Text>
                <Text style={[M.th, { width: 38 }]}>UIfps</Text>
                <Text style={[M.th, { width: 34 }]}>Min</Text>
                <Text style={[M.th, { width: 30 }]}>p5</Text>
                <Text style={[M.th, { width: 38 }]}>JS%</Text>
                <Text style={[M.th, { width: 38 }]}>CPU</Text>
                <Text style={[M.th, { width: 44 }]}>Mem</Text>
                {hasBlank && <Text style={[M.th, { width: 42 }]}>Blank</Text>}
              </View>

              {/* Per-run rows */}
              <ScrollView style={M.tableScroll} showsVerticalScrollIndicator={false}>
                {result.runs.map((r: RunResult) => (
                  <View key={r.name} style={M.tableRow}>
                    <Text style={[M.td, { width: 68 }]} numberOfLines={1}>{r.label}</Text>
                    <Text style={[M.td, { width: 38, color: fpsColor(r.avgFPS) }]}>{r.avgFPS}</Text>
                    <Text style={[M.td, { width: 34, color: fpsColor(r.minFPS) }]}>{r.minFPS}</Text>
                    <Text style={[M.td, { width: 30, color: fpsColor(r.p5FPS) }]}>{r.p5FPS}</Text>
                    <Text style={[M.td, { width: 38, color: idleColor(r.avgJSIdle) }]}>{r.avgJSIdle}%</Text>
                    <Text style={[M.td, { width: 38, color: cpuColor(r.avgCPU) }]}>
                      {r.avgCPU >= 0 ? `${r.avgCPU}%` : '—'}
                    </Text>
                    <Text style={[M.td, { width: 44, color: memColor(r.peakMemDeltaMB) }]}>
                      +{r.peakMemDeltaMB.toFixed(1)}M
                    </Text>
                    {hasBlank && (
                      <Text style={[M.td, { width: 42, color: r.avgBlankPct >= 0 ? blankColor(r.avgBlankPct) : '#555' }]}>
                        {r.avgBlankPct >= 0 ? `${r.avgBlankPct}%` : '—'}
                      </Text>
                    )}
                  </View>
                ))}
              </ScrollView>

              {/* Aggregate row */}
              <View style={M.aggRow}>
                <Text style={[M.aggLabel, { width: 68 }]}>TOTAL</Text>
                <Text style={[M.aggVal, { width: 38, color: fpsColor(agg.avgFPS) }]}>{agg.avgFPS}</Text>
                <Text style={[M.aggVal, { width: 34, color: fpsColor(agg.minFPS) }]}>{agg.minFPS}</Text>
                <Text style={[M.aggVal, { width: 30, color: fpsColor(agg.p5FPS) }]}>{agg.p5FPS}</Text>
                <Text style={[M.aggVal, { width: 38, color: idleColor(agg.avgJSIdle) }]}>{agg.avgJSIdle}%</Text>
                <Text style={[M.aggVal, { width: 38, color: cpuColor(agg.avgCPU) }]}>
                  {agg.avgCPU >= 0 ? `${agg.avgCPU}%` : '—'}
                </Text>
                <Text style={[M.aggVal, { width: 44, color: memColor(agg.peakMemDeltaMB) }]}>
                  +{agg.peakMemDeltaMB.toFixed(1)}M
                </Text>
                {hasBlank && (
                  <Text style={[M.aggVal, { width: 42, color: agg.avgBlankPct >= 0 ? blankColor(agg.avgBlankPct) : '#555' }]}>
                    {agg.avgBlankPct >= 0 ? `${agg.avgBlankPct}%` : '—'}
                  </Text>
                )}
              </View>
            </View>
          </ScrollView>

          {/* Extra stats */}
          <Text style={M.extraStats}>
            p5 FPS {agg.p5FPS}  ·  mounts {agg.totalMounts}
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
        </View>
      </View>
    </Modal>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PerfHood({
  activeMounts,
  totalMounts,
  scrollVelocity = 0,
  blankAreaPct = -1,
  scrollRef,
  engine = 'riff',
  tab = 'feed',
  itemCount = 0,
  itemHeight = 56,
  contentHeight = 0,
}: PerfHoodProps) {
  const m = usePerformanceMetrics();
  const [showResult, setShowResult] = useState(false);
  const prevResultRef = useRef<BenchmarkResult | null>(null);

  const benchmarkEnabled = !!scrollRef;

  const benchConfig: BenchmarkConfig = {
    scrollRef: scrollRef ?? { current: null },
    engine,
    tab,
    itemCount,
    itemHeight,
    contentHeight,
    liveMetrics: m,
    activeMounts,
    totalMounts,
    blankAreaPct,
  };

  const bench = useBenchmark(benchConfig);

  // Auto-show summary when a new result arrives; hide when result is cleared
  // (e.g. engine switch resets it to null).
  useEffect(() => {
    if (bench.result && bench.result !== prevResultRef.current) {
      prevResultRef.current = bench.result;
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
          onClose={() => setShowResult(false)}
          onRunAgain={handleRunAgain}
        />
      )}

      <View style={S.overlay} pointerEvents="box-none">
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
    bottom: 16,
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
