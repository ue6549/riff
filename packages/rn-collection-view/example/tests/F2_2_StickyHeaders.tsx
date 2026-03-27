/**
 * F2.2 — Sticky headers (basic)
 *
 * Section headers stick at the viewport top while their section is visible.
 * The sticky header is an overlay rendered in viewport-space — zero JS involvement
 * beyond the scroll callback that updates the active section.
 *
 * What to observe:
 *   - Scroll down: section 0 header sticks at top
 *   - When section 1 arrives, its header takes over and sticks
 *   - Scroll back up: header de-sticks and returns to its natural position
 *   - The sticky header is visually identical to the in-content header
 */
import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Riff, SectionConfig } from '../components/CollectionView';

// ─── Data ─────────────────────────────────────────────────────────────────────

type Item = { id: string; label: string };

const COLORS  = ['#1e3a5f', '#1a3a2a', '#3a1a1a', '#2a1a3a', '#3a2a1a', '#2a2a1a'];
const NAMES   = ['Unread', 'Flagged', 'Today', 'Yesterday', 'Last Week', 'Older'];

function makeSection(idx: number, count: number): SectionConfig<Item> {
  return {
    key: `s${idx}`,
    data: Array.from({ length: count }, (_, i) => ({
      id: `${idx}_${i}`,
      label: `${NAMES[idx]} · item ${i + 1}`,
    })),
    header: {
      height: 40,
      sticky: true,
      render: () => (
        <View style={[S.header, { backgroundColor: COLORS[idx] }]}>
          <Text style={S.headerIcon}>§</Text>
          <Text style={S.headerTitle}>{NAMES[idx]}</Text>
          <Text style={S.headerBadge}>{count}</Text>
        </View>
      ),
    },
  };
}

const SECTIONS: SectionConfig<Item>[] = [
  makeSection(0, 12),
  makeSection(1, 18),
  makeSection(2, 25),
  makeSection(3, 10),
  makeSection(4, 22),
  makeSection(5, 8),
];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function F2_2_StickyHeaders() {
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
        stickyMode="sticky"
        sectionInsetBottom={24}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },

  header:      { flexDirection: 'row', alignItems: 'center',
                 paddingHorizontal: 14, height: 40 },
  headerIcon:  { fontSize: 14, color: '#94a3b8', marginRight: 8 },
  headerTitle: { fontSize: 13, fontWeight: '700', color: '#e2e8f0', flex: 1 },
  headerBadge: { fontSize: 12, fontWeight: '600', color: '#60a5fa',
                 backgroundColor: '#0d2137', paddingHorizontal: 8,
                 paddingVertical: 2, borderRadius: 10 },

  cell:        { paddingHorizontal: 16, paddingVertical: 13,
                 borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  cellText:    { fontSize: 14, color: '#e2e8f0' },
});
