/**
 * M3.5 — Mounted-Cell Budget + LRU Eviction
 *
 * Verifies that the number of simultaneously mounted cells is capped at
 * `mountedWindowSize` regardless of how large the render window grows.
 *
 * The budget trims the render range from the end furthest from the visible
 * area, so the visible region is always fully covered.
 *
 * What to verify:
 *   · "Mounted" badge never exceeds the configured budget.
 *   · Scrolling fast (velocity window expands): budget still enforced.
 *   · Visible area always fully covered — no blank visible cells.
 *   · After budget eviction, scrolling back remounts cells cold (gen counter).
 *
 * Try different budgets with the selector to see the trade-off between
 * memory (low budget) and white-space risk (high budget / Infinity).
 */
import React, { useCallback, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Riff } from '@riff/components/CollectionView';

// ─── Mount counter (shared with M3.3 pattern) ────────────────────────────────

let _mounts = 0;
const _gens  = new Map<number, number>();

function recordMount(id: number): number {
  _mounts++;
  const g = (_gens.get(id) ?? 0) + 1;
  _gens.set(id, g);
  return g;
}
function resetMounts() { _mounts = 0; _gens.clear(); }

// ─── Data ─────────────────────────────────────────────────────────────────────

const ITEM_COUNT = 500;
const ITEM_H     = 60;
type Item = { id: number };
const DATA: Item[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({ id: i }));

// ─── Cell ─────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

function BudgetCell({ item }: { item: Item }) {
  const [gen, setGen] = useState(0);
  useEffect(() => { setGen(recordMount(item.id)); }, [item.id]);

  return (
    <View style={[S.cell, gen > 1 && S.cellRemount]}>
      <Text style={S.cellId}>#{item.id}</Text>
      <View style={[S.genPill, gen > 1 && S.genPillWarm]}>
        <Text style={S.genText}>gen {gen}</Text>
      </View>
    </View>
  );
}

// ─── Budget options ───────────────────────────────────────────────────────────

const BUDGETS = [2.0, 3.0, 5.0, Infinity] as const;
type Budget = typeof BUDGETS[number];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function M3_5_CellBudget() {
  const [budget,      setBudget]      = useState<Budget>(5.0);
  const [renderCount, setRenderCount] = useState(0);
  const [totalMounts, setTotalMounts] = useState(0);
  const [resetKey,    setResetKey]    = useState(0);

  const onRenderCountChange = useCallback((count: number) => {
    setRenderCount(count);
    setTotalMounts(_mounts);
  }, []);

  const handleBudgetChange = useCallback((b: Budget) => {
    resetMounts();
    setBudget(b);
    setResetKey(k => k + 1);
    setTotalMounts(0);
    setRenderCount(0);
  }, []);

  const budgetLabel = budget === Infinity ? '∞' : `${budget}×`;
  const overBudget  = false; // budget is a viewport multiple, not a cell count

  return (
    <SafeAreaView style={S.root}>
      {/* Header */}
      <View style={S.header}>
        <Text style={S.title}>M3.5 — Cell Budget</Text>
        <Text style={S.subtitle}>
          mountedWindowSize = viewport-height multiples · excess trimmed from far end
        </Text>

        {/* Budget selector */}
        <View style={S.budgetRow}>
          <Text style={S.budgetLabel}>Budget:</Text>
          {BUDGETS.map(b => (
            <Pressable
              key={String(b)}
              style={[S.budgetBtn, budget === b && S.budgetBtnActive]}
              onPress={() => handleBudgetChange(b)}
            >
              <Text style={[S.budgetBtnText, budget === b && S.budgetBtnTextActive]}>
                {b === Infinity ? '∞' : `${b}×`}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Stats */}
        <View style={S.stats}>
          <StatBadge
            label="Mounted"
            value={`${renderCount} / ${budgetLabel}`}
          />
          <StatBadge label="Total mounts" value={String(totalMounts)} accent />
          <StatBadge label="Items" value={String(ITEM_COUNT)} />
        </View>

      </View>

      <Riff
        key={resetKey}
        data={DATA}
        keyExtractor={item => String(item.id)}
        renderItem={({ item }) => <BudgetCell item={item} />}
        estimatedItemHeight={ITEM_H}
        itemSpacing={1}
        sectionInsetTop={8}
        sectionInsetBottom={24}
        renderMultiplier={1.0}
        mountedWindowSize={budget}
        onRenderCountChange={onRenderCountChange}
      />
    </SafeAreaView>
  );
}

function StatBadge({
  label, value, accent, alert,
}: { label: string; value: string; accent?: boolean; alert?: boolean }) {
  return (
    <View style={[S.badge, accent && S.badgeAccent, alert && S.badgeAlert]}>
      <Text style={S.badgeLabel}>{label}</Text>
      <Text style={[S.badgeValue, accent && S.badgeValueAccent, alert && S.badgeValueAlert]}>
        {value}
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:             { flex: 1, backgroundColor: '#0a0a0a' },

  header:           { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10,
                      borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  title:            { fontSize: 15, fontWeight: '700', color: '#fff', marginBottom: 2 },
  subtitle:         { fontSize: 11, color: '#555', marginBottom: 10 },

  budgetRow:        { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  budgetLabel:      { fontSize: 12, color: '#555' },
  budgetBtn:        { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6,
                      backgroundColor: '#1a1a1a' },
  budgetBtnActive:  { backgroundColor: '#1e3a1e' },
  budgetBtnText:    { fontSize: 13, fontWeight: '600', color: '#555' },
  budgetBtnTextActive: { color: '#4ade80' },

  stats:            { flexDirection: 'row', gap: 6 },
  badge:            { backgroundColor: '#161616', borderRadius: 8,
                      paddingHorizontal: 8, paddingVertical: 6, flex: 1 },
  badgeAccent:      { backgroundColor: '#0d2137' },
  badgeAlert:       { backgroundColor: '#2d0a0a' },
  badgeLabel:       { fontSize: 9, color: '#555', marginBottom: 2 },
  badgeValue:       { fontSize: 12, fontWeight: '700', color: '#fff', fontFamily: 'Menlo' },
  badgeValueAccent: { color: '#4ade80' },
  badgeValueAlert:  { color: '#f87171' },

  warning:          { fontSize: 11, color: '#f87171', marginTop: 6 },

  cell:             { flex: 1, flexDirection: 'row', alignItems: 'center',
                      paddingHorizontal: 14, backgroundColor: '#111', borderRadius: 4 },
  cellRemount:      { backgroundColor: '#1a1100' },
  cellId:           { fontSize: 12, color: '#555', fontFamily: 'Menlo', flex: 1 },
  genPill:          { backgroundColor: '#1a1a1a', borderRadius: 4,
                      paddingHorizontal: 6, paddingVertical: 2 },
  genPillWarm:      { backgroundColor: '#3d2500' },
  genText:          { fontSize: 10, color: '#555', fontFamily: 'Menlo' },
});
