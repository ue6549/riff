/**
 * F2.3 — Sticky push behaviour
 *
 * When the next section's header approaches the top of the viewport, it pushes
 * the current sticky header upward — matching UICollectionView's native behaviour.
 *
 *   stickyY = max(naturalY, min(scrollY, nextHeaderY − headerHeight))
 *
 * What to observe:
 *   - Section N header sticks at top while section N is visible
 *   - When section N+1 header approaches, it gradually pushes section N header up
 *   - Section N header slides off-screen; section N+1 sticks in its place
 *   - Scroll back: reverse transition, no duplicate headers visible
 *
 * Use tall sections (50 items) so the push effect is clearly visible.
 */
import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Riff, RiffSection } from '../components/CollectionView';

// ─── Data ─────────────────────────────────────────────────────────────────────

type Item = { id: string; label: string };

const BG_COLORS = ['#172554', '#14532d', '#450a0a', '#2e1065', '#431407', '#083344'];
const NAMES     = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];

function makeSection(idx: number): RiffSection<Item> {
  const count = 25 + idx * 5;
  return {
    key: `s${idx}`,
    data: Array.from({ length: count }, (_, i) => ({
      id:    `${idx}_${i}`,
      label: `${NAMES[idx]} — item ${i + 1} of ${count}`,
    })),
    header: {
      height: 44,
      sticky: true,
      render: () => (
        <View style={[S.header, { backgroundColor: BG_COLORS[idx] }]}>
          <View style={[S.headerDot, { backgroundColor: ACCENT_COLORS[idx] }]} />
          <Text style={S.headerTitle}>{NAMES[idx]}</Text>
          <Text style={S.headerSubtitle}>{count} items</Text>
        </View>
      ),
    },
  };
}

const ACCENT_COLORS = ['#3b82f6', '#22c55e', '#ef4444', '#a855f7', '#f97316', '#06b6d4'];

const SECTIONS: RiffSection<Item>[] = Array.from({ length: 6 }, (_, i) => makeSection(i));

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function F2_3_StickyPush() {
  const renderItem = useCallback(({ item }: { item: Item }) => (
    <View style={S.cell}>
      <Text style={S.cellText}>{item.label}</Text>
    </View>
  ), []);

  return (
    <View style={S.root}>
      <Riff
        sections={SECTIONS}
        renderItem={renderItem}
        estimatedItemHeight={44}
        stickyMode="push"
        sectionInsetBottom={32}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#0a0a0a' },

  header:        { flexDirection: 'row', alignItems: 'center',
                   paddingHorizontal: 14, height: 44 },
  headerDot:     { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  headerTitle:   { fontSize: 14, fontWeight: '700', color: '#e2e8f0', flex: 1 },
  headerSubtitle:{ fontSize: 11, color: '#94a3b8' },

  cell:          { paddingHorizontal: 16, paddingVertical: 13,
                   borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  cellText:      { fontSize: 14, color: '#e2e8f0' },
});
