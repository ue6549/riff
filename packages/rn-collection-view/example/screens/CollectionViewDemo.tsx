/**
 * CollectionView Demo — M2.1 / M2.3 / M2.4 / M3.1
 *
 * Live scrolling list of 200 items. As of M2.4 the list is virtualized:
 * only items inside the render window (1× viewport above + below) are
 * mounted. The render count badge in the header shows this live.
 *
 * As of M3.1, off-screen items inside the render window are wrapped in
 * <Activity mode="hidden"> so React can suspend them.
 *
 * What to verify:
 *   · "Rendered: X / 200" badge changes as you scroll
 *   · Near the top/bottom the count is ~30–40 (render window items)
 *   · Mid-list the count is ~30 (symmetric window)
 *   · Scrolling is still smooth (no jank from React re-renders)
 *   · Item positions are correct (no gaps, no overlaps)
 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Riff } from '@riff/components/CollectionView';

// ─── Data ─────────────────────────────────────────────────────────────────────

const ITEM_COUNT = 200;
const ITEM_H     = 56;
const SPACING    = 1;

type Item = { id: number; label: string; color: string };

const COLORS = [
  '#1a1a2e', '#16213e', '#0f3460', '#162447',
  '#1b262c', '#0a3d62', '#1e3799', '#0c2461',
];

const DATA: Item[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  id:    i,
  label: `Item ${i}`,
  color: COLORS[i % COLORS.length]!,
}));

// ─── Cell ─────────────────────────────────────────────────────────────────────

function Cell({ item }: { item: Item }) {
  return (
    <View style={[S.cell, { backgroundColor: item.color }]}>
      <Text style={S.index}>#{item.id}</Text>
      <Text style={S.label}>{item.label}</Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CollectionViewDemo() {
  const [renderCount, setRenderCount] = useState<number | null>(null);

  return (
    <View style={S.root}>
      <View style={S.header}>
        <View style={S.headerRow}>
          <Text style={S.headerTitle}>Riff Demo</Text>
          {renderCount !== null && (
            <View style={S.badge}>
              <Text style={S.badgeText}>
                Rendered: {renderCount} / {ITEM_COUNT}
              </Text>
            </View>
          )}
        </View>
        <Text style={S.headerSub}>
          {ITEM_COUNT} items · {ITEM_H}px · spacing {SPACING}px · renderMult=1×
        </Text>
      </View>

      <Riff
        data={DATA}
        keyExtractor={item => String(item.id)}
        renderItem={({ item }) => <Cell item={item} />}
        estimatedItemHeight={ITEM_H}
        itemSpacing={SPACING}
        sectionInsetTop={8}
        sectionInsetBottom={24}
        sectionInsetLeft={16}
        sectionInsetRight={16}
        renderMultiplier={1.0}
        onRenderCountChange={setRenderCount}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },

  header:      { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10,
                 borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  headerRow:   { flexDirection: 'row', alignItems: 'center',
                 justifyContent: 'space-between' },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#fff' },
  headerSub:   { fontSize: 11, color: '#555', marginTop: 2 },

  badge:       { backgroundColor: '#1a3a1a', borderRadius: 6,
                 paddingHorizontal: 8, paddingVertical: 3 },
  badgeText:   { fontSize: 11, color: '#4ade80', fontFamily: 'Menlo' },

  cell:        { flex: 1, flexDirection: 'row', alignItems: 'center',
                 paddingHorizontal: 14, borderRadius: 6 },
  index:       { fontSize: 12, color: '#ffffff66', fontFamily: 'Menlo',
                 width: 48 },
  label:       { fontSize: 14, color: '#fff', fontWeight: '500' },
});
