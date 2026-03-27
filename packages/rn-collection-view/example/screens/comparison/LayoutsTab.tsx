/**
 * Tab 4 — Layout Showcase
 *
 * Demonstrates all built-in layout engines with FlashList comparison callouts.
 *
 * Sub-tabs:
 *   Grid      — C++ GridLayout, fixed columns, row-aligned. FlashList: numColumns (similar).
 *   Masonry   — C++ MasonryLayout, shortest-column. FlashList: MasonryFlashList (available).
 *   Flow      — C++ FlowLayout, variable-width wrapping. FlashList: not possible.
 *   Radial Arc — TS custom layout, circular. FlashList: not possible.
 *   3D Carousel — TS custom layout, perspective. FlashList: not possible.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MasonryList } from '../../components/MasonryList';
import { GridList } from '../../components/GridList';
import { CircularList } from '../../components/CircularList';
import { Carousel3D } from '../../components/Carousel3D';
import NativeCollectionViewModule from 'riff/src/specs/NativeCollectionViewModule';

const nativeMod = NativeCollectionViewModule as unknown as {
  flowLayout: {
    computeFlowLayout(params: {
      itemCount: number;
      itemSpacing: number;
      lineSpacing: number;
      viewportWidth: number;
      sectionInsetTop?: number;
      sectionInsetBottom?: number;
      sectionInsetLeft?: number;
      sectionInsetRight?: number;
      itemWidths: number[];
      itemHeights: number[];
      keys: string[];
    }): { positions: number[]; contentHeight: number };
  };
};

// ── Shared colors ────────────────────────────────────────────────────────────

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];

// ── Grid data ────────────────────────────────────────────────────────────────

const GRID_COUNT = 200;
type GridItem = { id: number; color: string };
const GRID_DATA: GridItem[] = Array.from({ length: GRID_COUNT }, (_, i) => ({
  id: i,
  color: COLORS[i % COLORS.length]!,
}));

// ── Masonry data ─────────────────────────────────────────────────────────────

const MASONRY_COUNT = 200;
type MasonryItem = { id: number; height: number; color: string };
const MASONRY_DATA: MasonryItem[] = Array.from({ length: MASONRY_COUNT }, (_, i) => ({
  id: i,
  height: 80 + Math.floor(Math.random() * 120),
  color: COLORS[i % COLORS.length]!,
}));

// ── Flow data (tag cloud) ────────────────────────────────────────────────────

const TAG_LABELS = [
  'React Native', 'C++', 'JSI', 'TypeScript', 'Layout', 'Masonry', 'Grid',
  'Flow', 'Custom', 'Carousel', 'Performance', 'Virtualization', 'Windowing',
  'Sticky', 'Headers', 'Prefetch', 'Diff', 'Snapshot', 'Animation', 'Fabric',
  'Hermes', 'iOS', 'Android', 'Yoga', 'Riff', 'FlashList', 'FlatList',
  'ScrollView', 'Reanimated', 'Gesture', 'UIKit', 'SwiftUI', 'Compose', 'Kotlin',
  'Bridge', 'TurboModule', 'Codegen', 'Metro', 'Babel', 'SWC',
];
type FlowTag = { id: number; label: string; width: number; color: string };
const FLOW_DATA: FlowTag[] = TAG_LABELS.map((label, i) => ({
  id: i,
  label,
  width: 24 + label.length * 8.5, // approximate text width + padding
  color: COLORS[i % COLORS.length]!,
}));

// ── Circular + Carousel data ─────────────────────────────────────────────────

const CIRCULAR_COUNT = 12;
type CircularItem = { id: number; label: string; color: string };
const CIRCULAR_DATA: CircularItem[] = Array.from({ length: CIRCULAR_COUNT }, (_, i) => ({
  id: i,
  label: `${i}`,
  color: COLORS[i % COLORS.length]!,
}));

const CAROUSEL_COUNT = 8;
type CarouselItem = { id: number; title: string; color: string };
const CAROUSEL_DATA: CarouselItem[] = Array.from({ length: CAROUSEL_COUNT }, (_, i) => ({
  id: i,
  title: `Card ${i}`,
  color: COLORS[i % COLORS.length]!,
}));

// ── Flow layout component (lightweight, inline) ──────────────────────────────

function FlowList({ data }: { data: FlowTag[] }) {
  const [vpWidth, setVpWidth] = useState(0);
  const [vpHeight, setVpHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);

  const layout = React.useMemo(() => {
    if (vpWidth <= 0 || data.length === 0) return null;
    return nativeMod.flowLayout.computeFlowLayout({
      itemCount: data.length,
      itemSpacing: 8,
      lineSpacing: 8,
      viewportWidth: vpWidth,
      sectionInsetTop: 8,
      sectionInsetBottom: 8,
      sectionInsetLeft: 8,
      sectionInsetRight: 8,
      itemWidths: data.map(d => d.width),
      itemHeights: data.map(() => 34),
      keys: data.map(d => `flow-${d.id}`),
    });
  }, [data, vpWidth]);

  const cells = React.useMemo(() => {
    if (!layout || vpHeight <= 0) return null;
    const pad = 2 * vpHeight;
    const topEdge = scrollY - pad;
    const bottomEdge = scrollY + vpHeight + pad;
    const pos = layout.positions;
    const elements: React.ReactElement[] = [];

    for (let i = 0; i < data.length; i++) {
      const x = pos[i * 4]!;
      const y = pos[i * 4 + 1]!;
      const w = pos[i * 4 + 2]!;
      const h = pos[i * 4 + 3]!;
      if (y + h < topEdge || y > bottomEdge) continue;
      elements.push(
        <View key={data[i]!.id} style={{
          position: 'absolute', left: x, top: y, width: w, height: h,
          backgroundColor: data[i]!.color, borderRadius: 17,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={S.flowTagText}>{data[i]!.label}</Text>
        </View>
      );
    }
    return elements;
  }, [layout, scrollY, vpHeight, data]);

  return (
    <ScrollView
      style={S.flex}
      onLayout={(e: any) => { setVpWidth(e.nativeEvent.layout.width); setVpHeight(e.nativeEvent.layout.height); }}
      onScroll={(e: any) => setScrollY(e.nativeEvent.contentOffset.y)}
      scrollEventThrottle={16}
    >
      <View style={{ height: layout?.contentHeight ?? 0 }}>
        {cells}
      </View>
    </ScrollView>
  );
}

type SubTab = 'grid' | 'masonry' | 'flow' | 'circular' | 'carousel';

// ── Callout bullets per layout ───────────────────────────────────────────────
// type: 'green' = built-in/easy, 'amber' = possible but manual, 'red' = impossible, 'blue' = info

type Bullet = { type: 'green' | 'amber' | 'red' | 'blue'; text: string };

const CALLOUTS: Record<SubTab, Bullet[]> = {
  grid: [
    { type: 'green', text: 'FlashList: numColumns prop provides similar fixed-column grid layout.' },
    { type: 'blue', text: 'Engine: C++ GridLayout via JSI. Layout computed on UI thread.' },
  ],
  masonry: [
    { type: 'green', text: 'FlashList: MasonryFlashList available as a separate import. Similar capability.' },
    { type: 'blue', text: 'Engine: C++ MasonryLayout via JSI. Shortest-column placement.' },
  ],
  flow: [
    { type: 'amber', text: 'FlashList: Possible via custom LayoutProvider, like in RLV. Requires manual width tracking and row-break logic — not built-in.' },
    { type: 'blue', text: 'Engine: C++ FlowLayout via JSI. Variable-width items packed left-to-right, auto line-wrap.' },
  ],
  circular: [
    { type: 'red', text: 'FlashList: Not possible. Items must be in linear order. Radial/arc positioning requires arbitrary (x, y) placement.' },
    { type: 'blue', text: 'Scroll vertically to rotate the arc.' },
    { type: 'blue', text: 'Engine: TS custom layout. Can be rewritten in C++ for better perf, or in future codegen will generate C++ layout from JS.' },
  ],
  carousel: [
    { type: 'red', text: 'FlashList: Not possible. Requires per-item perspective transforms, scale by depth, and z-ordering — all driven by scroll position.' },
    { type: 'blue', text: 'Scroll horizontally to rotate the carousel.' },
    { type: 'blue', text: 'Engine: TS custom layout. Can be rewritten in C++ for better perf, or in future codegen will generate C++ layout from JS.' },
  ],
};

// ── Sub-tab picker ───────────────────────────────────────────────────────────

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'grid', label: 'Grid' },
  { key: 'masonry', label: 'Masonry' },
  { key: 'flow', label: 'Flow' },
  { key: 'circular', label: 'Radial Arc' },
  { key: 'carousel', label: '3D Carousel' },
];

export default function LayoutsTab() {
  const [subTab, setSubTab] = useState<SubTab>('grid');

  const getHeight = useCallback((item: MasonryItem) => item.height, []);
  const masonryKey = useCallback((item: MasonryItem) => String(item.id), []);
  const gridKey = useCallback((item: GridItem) => String(item.id), []);
  const circularKey = useCallback((item: CircularItem) => String(item.id), []);
  const carouselKey = useCallback((item: CarouselItem) => String(item.id), []);

  const bullets = CALLOUTS[subTab];

  return (
    <View style={S.root}>
      <View style={S.pickerRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={S.picker}>
          {SUB_TABS.map(t => (
            <Pressable
              key={t.key}
              style={[S.pickBtn, subTab === t.key && S.pickBtnActive]}
              onPress={() => setSubTab(t.key)}
            >
              <Text style={[S.pickText, subTab === t.key && S.pickTextActive]}>
                {t.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      <View style={S.bulletsContainer}>
        {bullets.map((b, i) => (
          <View key={i} style={[S.bullet, S[`bullet_${b.type}` as keyof typeof S] as any]}>
            <Text style={[S.bulletText, S[`bulletText_${b.type}` as keyof typeof S] as any]}>
              {b.text}
            </Text>
          </View>
        ))}
      </View>

      <View style={S.content}>
        {subTab === 'grid' && (
          <GridList
            data={GRID_DATA}
            columns={3}
            columnSpacing={8}
            rowSpacing={8}
            rowHeight={100}
            keyExtractor={gridKey}
            insets={{ top: 8, left: 8, right: 8, bottom: 8 }}
            renderItem={({ item }) => (
              <View style={[S.gridCell, { backgroundColor: item.color }]}>
                <Text style={S.gridCellText}>{item.id}</Text>
              </View>
            )}
          />
        )}

        {subTab === 'masonry' && (
          <MasonryList
            data={MASONRY_DATA}
            columns={2}
            columnSpacing={8}
            rowSpacing={8}
            getItemHeight={getHeight}
            keyExtractor={masonryKey}
            insets={{ top: 8, left: 8, right: 8, bottom: 8 }}
            renderItem={({ item }) => (
              <View style={[S.masonryCell, { backgroundColor: item.color }]}>
                <Text style={S.masonryCellText}>{item.id}</Text>
                <Text style={S.masonryCellSub}>{item.height}px</Text>
              </View>
            )}
          />
        )}

        {subTab === 'flow' && (
          <FlowList data={FLOW_DATA} />
        )}

        {subTab === 'circular' && (
          <CircularList
            data={CIRCULAR_DATA}
            itemSize={70}
            keyExtractor={circularKey}
            renderItem={({ item }) => (
              <View style={[S.circularCell, { backgroundColor: item.color }]}>
                <Text style={S.circularText}>{item.label}</Text>
              </View>
            )}
          />
        )}

        {subTab === 'carousel' && (
          <Carousel3D
            data={CAROUSEL_DATA}
            itemWidth={160}
            itemHeight={200}
            keyExtractor={carouselKey}
            renderItem={({ item }) => (
              <View style={[S.carouselCard, { backgroundColor: item.color }]}>
                <Text style={S.carouselTitle}>{item.title}</Text>
              </View>
            )}
          />
        )}
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pickerRow: { flexShrink: 0 },
  picker: { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 8 },
  pickBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6,
             backgroundColor: '#1a1a1a', alignItems: 'center' },
  pickBtnActive: { backgroundColor: '#1e3a1e' },
  pickText: { fontSize: 10, fontWeight: '600', color: '#555' },
  pickTextActive: { color: '#4ade80' },

  bulletsContainer: { paddingHorizontal: 8, gap: 4, marginBottom: 6 },
  bullet: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  bulletText: { fontSize: 11, lineHeight: 16 },
  bullet_green: { backgroundColor: '#1a2a1a' },
  bulletText_green: { color: '#6ee7b7' },
  bullet_amber: { backgroundColor: '#2a2510' },
  bulletText_amber: { color: '#fcd34d' },
  bullet_red: { backgroundColor: '#2a1a1a' },
  bulletText_red: { color: '#fca5a5' },
  bullet_blue: { backgroundColor: '#1a1a2a' },
  bulletText_blue: { color: '#93c5fd' },

  content: { flex: 1 },

  gridCell: { flex: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  gridCellText: { fontSize: 18, fontWeight: '700', color: '#fff' },

  masonryCell: { flex: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  masonryCellText: { fontSize: 18, fontWeight: '700', color: '#fff' },
  masonryCellSub: { fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 2 },

  flowTagText: { fontSize: 12, fontWeight: '600', color: '#fff' },

  circularCell: { flex: 1, borderRadius: 35, alignItems: 'center', justifyContent: 'center' },
  circularText: { fontSize: 20, fontWeight: '700', color: '#fff' },

  carouselCard: { flex: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                  shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                  shadowOpacity: 0.4, shadowRadius: 12 },
  carouselTitle: { fontSize: 20, fontWeight: '700', color: '#fff' },
});
