/**
 * F1.3 — Prefetch callbacks
 *
 * Demonstrates onPrefetch / onEvict:
 *   onPrefetch(keys) — fires when items enter the prefetch window
 *                       (prefetchAhead × viewport ahead of the render range)
 *   onEvict(keys)    — fires when items leave the prefetch window
 *
 * What to observe:
 *   - Scroll down: prefetch events fire before cells mount (they're ahead)
 *   - Scroll up fast: evict events fire for items that left the window
 *   - Prefetch count consistently exceeds render count
 *   - onEvict only fires after items are well behind (evict window = prefetch window)
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff } from '@riff/components/CollectionView';

// ─── Data ─────────────────────────────────────────────────────────────────────

type Item = { id: string; label: string };

const TOTAL = 500;
const data: Item[] = Array.from({ length: TOTAL }, (_, i) => ({
  id: String(i),
  label: `Item ${i}`,
}));

const keyExtractor = (item: Item) => item.id;

// ─── Log entry ────────────────────────────────────────────────────────────────

type LogEntry = {
  kind: 'prefetch' | 'evict';
  keys: string[];
  ts: number;
};

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function F1_3_PrefetchCallbacks() {
  const [log,            setLog]            = useState<LogEntry[]>([]);
  const [prefetchTotal,  setPrefetchTotal]  = useState(0);
  const [evictTotal,     setEvictTotal]     = useState(0);
  const [renderCount,    setRenderCount]    = useState(0);
  const prefetchTotalRef = useRef(0);
  const evictTotalRef    = useRef(0);

  const handlePrefetch = useCallback((keys: string[]) => {
    prefetchTotalRef.current += keys.length;
    setPrefetchTotal(prefetchTotalRef.current);
    setLog(prev => [{
      kind: 'prefetch' as const,
      keys: keys.slice(0, 5),  // show first 5 to keep log readable
      ts: Date.now(),
    }, ...prev].slice(0, 30));
  }, []);

  const handleEvict = useCallback((keys: string[]) => {
    evictTotalRef.current += keys.length;
    setEvictTotal(evictTotalRef.current);
    setLog(prev => [{
      kind: 'evict' as const,
      keys: keys.slice(0, 5),
      ts: Date.now(),
    }, ...prev].slice(0, 30));
  }, []);

  const renderItem = useCallback(({ item }: { item: Item }) => (
    <View style={S.cell}>
      <Text style={S.cellText}>{item.label}</Text>
    </View>
  ), []);

  return (
    <View style={S.root}>
      {/* ── Stats bar ── */}
      <View style={S.stats}>
        <StatBadge label="Rendered" value={renderCount} color="#4ade80" />
        <StatBadge label="Prefetched" value={prefetchTotal} color="#60a5fa" />
        <StatBadge label="Evicted" value={evictTotal} color="#f87171" />
        <StatBadge label="Total" value={TOTAL} color="#94a3b8" />
      </View>

      {/* ── Description ── */}
      <View style={S.desc}>
        <Text style={S.descText}>
          Scroll to trigger prefetch (12× viewport ahead).
          Evict fires when items leave the window.
        </Text>
      </View>

      {/* ── Event log ── */}
      {log.length > 0 && (
        <ScrollView style={S.log} scrollEnabled>
          {log.map((entry, i) => (
            <View key={i} style={S.logRow}>
              <Text style={[S.logKind, { color: entry.kind === 'prefetch' ? '#60a5fa' : '#f87171' }]}>
                {entry.kind === 'prefetch' ? '↓ prefetch' : '↑ evict   '}
              </Text>
              <Text style={S.logKeys}>
                [{entry.keys.join(', ')}{entry.keys.length < 5 ? '' : '…'}]
              </Text>
            </View>
          ))}
        </ScrollView>
      )}

      {/* ── List ── */}
      <View style={S.list}>
        <Riff
          data={data}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          estimatedItemHeight={44}
          onPrefetch={handlePrefetch}
          onEvict={handleEvict}
          prefetchAhead={12}
          onRenderCountChange={(count) => setRenderCount(count)}
        />
      </View>
    </View>
  );
}

// ─── StatBadge ────────────────────────────────────────────────────────────────

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={S.badge}>
      <Text style={[S.badgeValue, { color }]}>{value}</Text>
      <Text style={S.badgeLabel}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },
  stats:       { flexDirection: 'row', justifyContent: 'space-around',
                 paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  badge:       { alignItems: 'center' },
  badgeValue:  { fontSize: 20, fontWeight: '700', fontFamily: 'Menlo' },
  badgeLabel:  { fontSize: 10, color: '#555', marginTop: 2 },
  desc:        { paddingHorizontal: 12, paddingVertical: 8 },
  descText:    { fontSize: 11, color: '#555', fontFamily: 'Menlo' },
  log:         { maxHeight: 160, borderTopWidth: 1, borderTopColor: '#1a1a1a',
                 borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  logRow:      { flexDirection: 'row', alignItems: 'center',
                 paddingHorizontal: 10, paddingVertical: 4,
                 borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  logKind:     { fontSize: 11, fontWeight: '600', fontFamily: 'Menlo', width: 80 },
  logKeys:     { fontSize: 11, color: '#888', fontFamily: 'Menlo', flex: 1 },
  list:        { flex: 1 },
  cell:        { paddingHorizontal: 16, paddingVertical: 13,
                 borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  cellText:    { fontSize: 14, color: '#e2e8f0' },
});
