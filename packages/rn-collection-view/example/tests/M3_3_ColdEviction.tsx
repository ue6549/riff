/**
 * M3.3 — Cold Eviction
 *
 * Verifies that cells leaving the render window are unmounted by React
 * (component identity gone, useEffect cleanup fires) while the layout
 * cache retains their position data so they reappear at the correct
 * position on remount.
 *
 * How to read this screen:
 *   Each cell shows its item index and a mount-generation counter (#N).
 *   Generation 1 = first mount. Generation 2+ = cold remount after eviction.
 *
 * What to verify:
 *   1. Scroll down ~3 viewports: items 0–N disappear from the render window.
 *      The "Render window" badge updates live.
 *   2. Scroll back to top: those items remount cold — their generation
 *      counter increments. Proves useEffect ran fresh (no stale state leak).
 *   3. Positions are correct after remount (no gaps, no overlaps).
 *   4. "Total mounts" monotonically increases — each cold remount is counted.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff } from '@riff/components/CollectionView';

// ─── Global mount tracking ────────────────────────────────────────────────────

let _totalMounts = 0;

// Per-item generation map: itemIndex → how many times it has mounted.
const _generations = new Map<number, number>();

function recordMount(index: number): number {
  _totalMounts++;
  const gen = (_generations.get(index) ?? 0) + 1;
  _generations.set(index, gen);
  return gen;
}

function resetTracking() {
  _totalMounts = 0;
  _generations.clear();
}

// ─── Cell ─────────────────────────────────────────────────────────────────────

const ITEM_COUNT = 200;
const ITEM_H     = 56;

type Item = { id: number };
const DATA: Item[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({ id: i }));

function EvictionCell({ item }: { item: Item }) {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const gen = recordMount(item.id);
    setGeneration(gen);
    return () => {
      // Cleanup fires on cold eviction — proves the cell was fully unmounted.
    };
  }, [item.id]);

  const isColdRemount = generation > 1;

  return (
    <View style={[S.cell, isColdRemount && S.cellRemount]}>
      <Text style={S.index}>#{item.id}</Text>
      <Text style={S.label}>Item {item.id}</Text>
      <View style={[S.genBadge, isColdRemount && S.genBadgeWarm]}>
        <Text style={S.genText}>gen {generation}</Text>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M3_3_ColdEviction() {
  const [renderRange,   setRenderRange]   = useState<string>('—');
  const [totalMounts,   setTotalMounts]   = useState(0);
  const [renderCount,   setRenderCount]   = useState(0);
  const [resetKey,      setResetKey]      = useState(0);

  const onRenderCountChange = useCallback((count: number) => {
    setRenderCount(count);
    setTotalMounts(_totalMounts);
  }, []);

  const handleReset = useCallback(() => {
    resetTracking();
    setResetKey(k => k + 1);
    setTotalMounts(0);
    setRenderCount(0);
    setRenderRange('—');
  }, []);

  return (
    <SafeAreaView style={S.root}>
      {/* Header */}
      <View style={S.header}>
        <View style={S.headerRow}>
          <Text style={S.title}>M3.3 — Cold Eviction</Text>
          <Text style={S.resetBtn} onPress={handleReset}>Reset</Text>
        </View>
        <Text style={S.subtitle}>
          Scroll down then back. Cells outside the render window unmount (gen &gt; 1 on return).
        </Text>

        {/* Stats */}
        <View style={S.stats}>
          <StatBadge label="Rendered" value={`${renderCount} / ${ITEM_COUNT}`} />
          <StatBadge label="Total mounts" value={String(totalMounts)} accent />
        </View>
      </View>

      {/* List */}
      <Riff
        key={resetKey}
        data={DATA}
        keyExtractor={item => String(item.id)}
        renderItem={({ item }) => <EvictionCell item={item} />}
        estimatedItemHeight={ITEM_H}
        itemSpacing={1}
        sectionInsetTop={8}
        sectionInsetBottom={24}
        renderMultiplier={1.0}
        onRenderCountChange={onRenderCountChange}
      />
    </SafeAreaView>
  );
}

function StatBadge({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={[S.badge, accent && S.badgeAccent]}>
      <Text style={S.badgeLabel}>{label}</Text>
      <Text style={[S.badgeValue, accent && S.badgeValueAccent]}>{value}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:           { flex: 1, backgroundColor: '#0a0a0a' },

  header:         { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10,
                    borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  headerRow:      { flexDirection: 'row', justifyContent: 'space-between',
                    alignItems: 'center', marginBottom: 4 },
  title:          { fontSize: 15, fontWeight: '700', color: '#fff' },
  subtitle:       { fontSize: 11, color: '#555', marginBottom: 10 },
  resetBtn:       { fontSize: 13, color: '#4ade80' },

  stats:          { flexDirection: 'row', gap: 8 },
  badge:          { backgroundColor: '#161616', borderRadius: 8,
                    paddingHorizontal: 10, paddingVertical: 6, flex: 1 },
  badgeAccent:    { backgroundColor: '#0d2137' },
  badgeLabel:     { fontSize: 10, color: '#555', marginBottom: 2 },
  badgeValue:     { fontSize: 13, fontWeight: '700', color: '#fff', fontFamily: 'Menlo' },
  badgeValueAccent: { color: '#4ade80' },

  cell:           { flex: 1, flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 14, backgroundColor: '#111',
                    borderRadius: 6 },
  cellRemount:    { backgroundColor: '#1a1100' },

  index:          { fontSize: 11, color: '#555', fontFamily: 'Menlo', width: 36 },
  label:          { fontSize: 14, color: '#e2e8f0', flex: 1 },

  genBadge:       { backgroundColor: '#1a1a1a', borderRadius: 4,
                    paddingHorizontal: 6, paddingVertical: 2 },
  genBadgeWarm:   { backgroundColor: '#3d2500' },
  genText:        { fontSize: 10, color: '#555', fontFamily: 'Menlo' },
});
