/**
 * F2.4 — Decoration views
 *
 * Per-section background views rendered INSIDE the scroll content via
 * renderScrollView injection (not as a viewport-space overlay). This means
 * they scroll in perfect sync with cells — no JS-state lag.
 *
 * Layout inside the ScrollView:
 *   <ScrollView>
 *     <View position:absolute top:sectionY height:sectionH>  ← decoration (behind)
 *     <View height:contentHeight>{cells}</View>               ← CollectionView content (front)
 *
 * What to observe:
 *   - Each section has a clearly visible tinted background
 *   - Backgrounds scroll in perfect sync with cells (no drift/lag)
 *   - Sticky headers float above both cells and backgrounds (zIndex:100)
 *   - Decorations do not intercept touches (pointerEvents="none")
 */
import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Riff, SectionConfig } from '../components/CollectionView';

// ─── Data ─────────────────────────────────────────────────────────────────────

type Item = { id: string; label: string; subtitle: string };

const SECTION_DATA = [
  { name: 'Featured',     accent: '#3b82f6', bg: '#0d1f3c', count: 6  },
  { name: 'Popular',      accent: '#22c55e', bg: '#0a1f15', count: 10 },
  { name: 'New Releases', accent: '#f97316', bg: '#1f1108', count: 8  },
  { name: 'Staff Picks',  accent: '#a855f7', bg: '#1a0a2e', count: 12 },
  { name: 'Trending',     accent: '#06b6d4', bg: '#051a1f', count: 9  },
];

function makeSection(
  idx: number,
  info: typeof SECTION_DATA[number],
): SectionConfig<Item> {
  return {
    key: `sec_${idx}`,
    data: Array.from({ length: info.count }, (_, i) => ({
      id:       `${idx}_${i}`,
      label:    `${info.name} · item ${i + 1}`,
      subtitle: `Details for item ${i + 1}`,
    })),
    header: {
      height: 48,
      sticky: true,
      render: () => (
        <View style={[S.header, { borderLeftColor: info.accent, backgroundColor: info.bg }]}>
          <Text style={[S.headerTitle, { color: info.accent }]}>{info.name}</Text>
          <Text style={S.headerCount}>{info.count} items</Text>
        </View>
      ),
    },
  };
}

const SECTIONS: SectionConfig<Item>[] = SECTION_DATA.map((info, i) => makeSection(i, info));

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function F2_4_DecorationViews() {
  const renderItem = useCallback(({ item }: { item: Item }) => (
    <View style={S.cell}>
      <Text style={S.cellLabel}>{item.label}</Text>
      <Text style={S.cellSubtitle}>{item.subtitle}</Text>
    </View>
  ), []);

  // Decoration: solid dark tint per section — opaque enough to be clearly visible.
  // The View fills the parent (position:absolute, full width/height managed by
  // CollectionView's renderScrollView injection).
  const renderSectionBackground = useCallback((sectionIndex: number) => {
    const info = SECTION_DATA[sectionIndex];
    if (!info) return null;
    return <View style={[StyleSheet.absoluteFillObject, { backgroundColor: info.bg }]} />;
  }, []);

  return (
    <View style={S.root}>
      <Riff
        sections={SECTIONS}
        renderItem={renderItem}
        estimatedItemHeight={56}
        stickyMode="push"
        renderSectionBackground={renderSectionBackground}
        sectionInsetBottom={24}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#0a0a0a' },

  header:      { paddingHorizontal: 16, height: 48,
                 justifyContent: 'center', borderLeftWidth: 3 },
  headerTitle: { fontSize: 15, fontWeight: '700' },
  headerCount: { fontSize: 11, color: '#94a3b8', marginTop: 2 },

  cell:        { paddingHorizontal: 16, paddingVertical: 14,
                 borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1c1c1e' },
  cellLabel:   { fontSize: 14, color: '#e2e8f0', fontWeight: '500' },
  cellSubtitle:{ fontSize: 12, color: '#94a3b8', marginTop: 2 },
});
