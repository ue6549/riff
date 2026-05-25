/**
 * F2.1 — Non-sticky supplementary views
 *
 * Section headers and footers rendered at their natural Y positions.
 * They participate in windowing: headers/footers outside the render window
 * are not mounted, exactly like data cells.
 *
 * What to observe:
 *   - Each section shows a tinted header at the correct Y position
 *   - Headers scroll with the content (not sticky)
 *   - Section footers appear at the bottom of each section
 *   - Render count shows headers + footers + cells combined
 */
import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Riff, RiffSection } from '@riff/components/CollectionView';

// ─── Data ─────────────────────────────────────────────────────────────────────

type Item = { id: string; label: string };

const SECTION_COLORS = ['#1e3a5f', '#1a3a2a', '#3a1a1a', '#2a1a3a', '#3a2a1a'];
const SECTION_LABELS = ['Inbox', 'Sent', 'Drafts', 'Archive', 'Trash'];

function makeSection(idx: number, count: number): RiffSection<Item> {
  return {
    key: `section_${idx}`,
    data: Array.from({ length: count }, (_, i) => ({
      id: `${idx}_${i}`,
      label: `${SECTION_LABELS[idx]} item ${i + 1}`,
    })),
    header: {
      height: 36,
      render: () => (
        <View style={[S.header, { backgroundColor: SECTION_COLORS[idx] }]}>
          <Text style={S.headerTitle}>{SECTION_LABELS[idx]}</Text>
          <Text style={S.headerCount}>{count} items</Text>
        </View>
      ),
    },
    footer: {
      height: 28,
      render: () => (
        <View style={S.footer}>
          <Text style={S.footerText}>End of {SECTION_LABELS[idx]}</Text>
        </View>
      ),
    },
  };
}

const SECTIONS: RiffSection<Item>[] = [
  makeSection(0, 20),
  makeSection(1, 15),
  makeSection(2, 8),
  makeSection(3, 30),
  makeSection(4, 12),
];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function F2_1_SupplementaryViews() {
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
        itemSpacing={0}
        sectionInsetTop={0}
        sectionInsetBottom={16}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },

  header:      { flexDirection: 'row', alignItems: 'center',
                 paddingHorizontal: 16, height: 36 },
  headerTitle: { fontSize: 13, fontWeight: '700', color: '#e2e8f0', flex: 1 },
  headerCount: { fontSize: 11, color: '#94a3b8' },

  footer:      { alignItems: 'center', justifyContent: 'center',
                 height: 28, borderBottomWidth: StyleSheet.hairlineWidth,
                 borderBottomColor: '#1a1a1a' },
  footerText:  { fontSize: 10, color: '#444', fontFamily: 'Menlo' },

  cell:        { paddingHorizontal: 16, paddingVertical: 13,
                 borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  cellText:    { fontSize: 14, color: '#e2e8f0' },
});
