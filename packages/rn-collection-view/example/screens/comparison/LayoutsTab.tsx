/**
 * Tab 4 — Layout Showcase (ShadowNode-powered)
 *
 * Demonstrates all built-in layout engines using CollectionView with the
 * ShadowNode path. Each layout type is backed by a C++ engine that writes
 * complete LayoutAttributes to the shared LayoutCache. The ShadowNode reads
 * the cache and applies positions — it has no layout-type-specific logic.
 *
 * Sub-tabs:
 *   List      — C++ ListLayout, vertical list. FlashList: core use case.
 *   Grid      — C++ GridLayout, fixed columns, row-aligned. FlashList: numColumns (similar).
 *   Masonry   — C++ MasonryLayout, shortest-column. FlashList: MasonryFlashList (available).
 *   Flow      — C++ FlowLayout, variable-width wrapping. FlashList: not possible.
 *              Shows the two-pass effect: estimated sizes → Yoga measurement → reflow.
 *   Radial Arc — TS custom layout, circular. FlashList: not possible.
 *   3D Carousel — TS custom layout, perspective. FlashList: not possible.
 */
import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, Animated, Easing } from 'react-native';
import { Riff as CollectionView } from '../../components/CollectionView';
import { list } from '../../../src/layouts/list';
import { grid } from '../../../src/layouts/grid';
import { masonry } from '../../../src/layouts/masonry';
import { flow } from '../../../src/layouts/flow';
import { CircularList } from '../../components/CircularList';
import { Carousel3D } from '../../components/Carousel3D';

// ── Shared colors ────────────────────────────────────────────────────────────

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];

// ── List data ────────────────────────────────────────────────────────────────

const LIST_COUNT = 500;
type ListItem = { id: string; color: string; num: number; subtitle: string };
const LIST_DATA: ListItem[] = Array.from({ length: LIST_COUNT }, (_, i) => {
  const lineCount = (i % 3) + 1;
  const subtitle = Array(lineCount).fill('This is a dynamically sized text line that proves Yoga intrinsic measurement works perfectly.').join('\n');
  return {
    id: `list-${i}`,
    color: COLORS[i % COLORS.length]!,
    num: i,
    subtitle,
  };
});

// ── Grid data ────────────────────────────────────────────────────────────────

const GRID_COUNT = 200;
type GridItem = { id: string; color: string; num: number };
const GRID_DATA: GridItem[] = Array.from({ length: GRID_COUNT }, (_, i) => ({
  id: `grid-${i}`,
  color: COLORS[i % COLORS.length]!,
  num: i,
}));

// ── Masonry data ─────────────────────────────────────────────────────────────

const MASONRY_COUNT = 200;
type MasonryItem = { id: string; height: number; color: string; num: number };
const MASONRY_HEIGHTS = Array.from({ length: MASONRY_COUNT }, () => 80 + Math.floor(Math.random() * 120));
const MASONRY_DATA: MasonryItem[] = Array.from({ length: MASONRY_COUNT }, (_, i) => ({
  id: `masonry-${i}`,
  height: MASONRY_HEIGHTS[i]!,
  color: COLORS[i % COLORS.length]!,
  num: i,
}));

// ── Flow data (tag cloud) — Two-pass demo ────────────────────────────────────
// The two-pass effect: initial render uses estimated sizes from sizeForItem().
// Yoga then measures actual text widths. The layout engine receives the deltas
// and reflows items into different row positions. Items visibly rearrange from
// estimated to measured positions.

const TAG_LABELS = [
  'React Native', 'C++', 'JSI', 'TypeScript', 'Layout Engine', 'Masonry', 'Grid',
  'Flow', 'Custom', 'Carousel', 'Performance', 'Virtualization', 'Windowing',
  'Sticky', 'Headers', 'Prefetch', 'Diff', 'Snapshot', 'Animation', 'Fabric',
  'Hermes', 'iOS', 'Android', 'Yoga', 'Riff', 'FlashList', 'FlatList',
  'ScrollView', 'Reanimated', 'Gesture Handler', 'UIKit', 'SwiftUI', 'Compose',
  'Kotlin', 'Bridge', 'TurboModule', 'Codegen', 'Metro', 'Babel', 'SWC',
  // Longer labels to make two-pass effect more visible
  'Layout Cache Architecture', 'Shadow Node Measurement', 'Content Determined Dimensions',
  'Shortest Column Algorithm', 'Row Height Alignment', 'Viewport Windowing',
  'Cell Identity Preservation', 'Scroll Offset Correction', 'Progressive Layout',
  'Three-Tier Height Resolution',
];
type FlowTag = { id: string; label: string; estimatedWidth: number; color: string };
const FLOW_DATA: FlowTag[] = TAG_LABELS.map((label, i) => ({
  id: `flow-${i}`,
  label,
  // Intentionally imprecise estimate — the two-pass effect corrects this.
  estimatedWidth: 20 + label.length * 7,
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

// ── List layout config ──────────────────────────────────────────────────────

// ── Supplemental Animated Components ──────────────────────────────────────────

function AnimatedSectionBackground({ sectionIndex }: { sectionIndex: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const opacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.05, 0.15]
  });

  return <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: COLORS[sectionIndex % COLORS.length]!, opacity }]} />;
}

function AnimatedTimerHeader({ title, color }: { title: string, color: string }) {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const int = setInterval(() => setTicks(t => t + 1), 100);
    return () => clearInterval(int);
  }, []);
  
  return (
    <View style={{ height: 50, backgroundColor: color, justifyContent: 'center', paddingHorizontal: 16 }}>
      <Text style={{ color: '#fff', fontWeight: 'bold' }}>{title}  |  Ticks Native State: {ticks}</Text>
    </View>
  );
}

function AnimatedTimerFooter({ title }: { title: string }) {
  return (
    <View style={{ height: 30, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ color: '#aaa', fontSize: 12, fontWeight: 'bold' }}>{title}</Text>
    </View>
  );
}

// ── List layout config ──────────────────────────────────────────────────────

function ListDemo() {
  const listLayout = useMemo(() => list({
    estimatedItemHeight: 72,
    itemSpacing: 8,
    stickyMode: 'push',
  }), []);

  const sections = useMemo(() => [{
    key: 'section-0',
    data: LIST_DATA.slice(0, 50),
    header: {
      render: () => (
        <View style={{ height: 50, backgroundColor: '#e94560', justifyContent: 'center', paddingHorizontal: 16 }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold' }}>Section 1</Text>
        </View>
      ),
      height: 50,
      sticky: true,
    },
    footer: {
      render: () => <AnimatedTimerFooter title="Section 1 Footer" />,
      height: 30,
      sticky: true,
    },
    insets: { top: 8, bottom: 8, left: 0, right: 0 },
  }], []);

  return (
    <CollectionView
      sections={sections}
      layout={listLayout}
      estimatedItemHeight={72}
      scrollViewProps={{ style: { backgroundColor: '#2a2a3e' }, indicatorStyle: 'white' }}
      keyExtractor={useCallback((item: ListItem) => item.id, [])}
      renderItem={useCallback(({ item }: { item: ListItem }) => (
        <View style={{ backgroundColor: '#1a1a2e', borderLeftWidth: 4, borderLeftColor: item.color, paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>Item {item.num}</Text>
          <Text style={{ color: '#aaa', fontSize: 13, marginTop: 4 }}>{item.subtitle}</Text>
        </View>
      ), [])}
    />
  );
}

// ── Grid layout config ──────────────────────────────────────────────────────

function GridDemo() {
  const gridLayout = useMemo(() => grid({
    columns: 3,
    rowHeight: 100,
    columnSpacing: 8,
    rowSpacing: 8,
  }), []);

  return (
    <CollectionView
      data={GRID_DATA}
      layout={gridLayout}
      estimatedItemHeight={100}
      sectionInsetTop={8}
      sectionInsetBottom={8}
      sectionInsetLeft={8}
      sectionInsetRight={8}
      keyExtractor={useCallback((item: GridItem) => item.id, [])}
      renderItem={useCallback(({ item }: { item: GridItem }) => (
        <View style={[S.gridCell, { backgroundColor: item.color }]}>
          <Text style={S.gridCellText}>{item.num}</Text>
        </View>
      ), [])}
    />
  );
}

// ── Masonry layout config ───────────────────────────────────────────────────

function MasonryDemo() {
  const masonryLayout = useMemo(() => masonry({
    columns: 2,
    columnSpacing: 8,
    rowSpacing: 8,
    heightForItem: (index: number) => MASONRY_HEIGHTS[index] ?? 100,
  }), []);

  return (
    <CollectionView
      data={MASONRY_DATA}
      layout={masonryLayout}
      estimatedItemHeight={140}
      sectionInsetTop={8}
      sectionInsetBottom={8}
      sectionInsetLeft={8}
      sectionInsetRight={8}
      keyExtractor={useCallback((item: MasonryItem) => item.id, [])}
      renderItem={useCallback(({ item }: { item: MasonryItem }) => (
        <View style={[S.masonryCell, { backgroundColor: item.color }]}>
          <Text style={S.masonryCellText}>{item.num}</Text>
          <Text style={S.masonryCellSub}>{item.height}px</Text>
        </View>
      ), [])}
    />
  );
}

// ── Flow layout config (two-pass demo) ──────────────────────────────────────

function FlowDemo() {
  const [pass, setPass] = useState(0);

  const flowLayout = useMemo(() => flow({
    itemSpacing: 8,
    lineSpacing: 8,
    sizeForItem: (index: number) => ({
      width: FLOW_DATA[index]?.estimatedWidth ?? 80,
      height: 34,
    }),
  }), []);

  return (
    <View style={S.flex}>
      <View style={S.flowInfoBar}>
        <Text style={S.flowInfoText}>
          Two-pass demo: tags use estimated widths initially.{'\n'}
          Yoga measures actual text width → layout reflows.{'\n'}
          Watch items rearrange from estimated to measured positions.
        </Text>
      </View>
      <CollectionView
        data={FLOW_DATA}
        layout={flowLayout}
        estimatedItemHeight={34}
        sectionInsetTop={8}
        sectionInsetBottom={8}
        sectionInsetLeft={8}
        sectionInsetRight={8}
        keyExtractor={useCallback((item: FlowTag) => item.id, [])}
        renderItem={useCallback(({ item }: { item: FlowTag }) => (
          <View style={[S.flowTag, { backgroundColor: item.color }]}>
            <Text style={S.flowTagText}>{item.label}</Text>
          </View>
        ), [])}
      />
    </View>
  );
}

type SubTab = 'list' | 'grid' | 'masonry' | 'flow' | 'circular' | 'carousel';

// ── Callout bullets per layout ───────────────────────────────────────────────
type Bullet = { type: 'green' | 'amber' | 'red' | 'blue'; text: string };

const CALLOUTS: Record<SubTab, Bullet[]> = {
  list: [
    { type: 'green', text: 'FlashList: Core use case. FlatList replacement with recycling.' },
    { type: 'blue', text: 'Engine: C++ ListLayout via JSI → ShadowNode applies positions from LayoutCache.' },
    { type: 'blue', text: 'Default layout: when no layout prop is given, Riff auto-creates a ListLayout.' },
  ],
  grid: [
    { type: 'green', text: 'FlashList: numColumns prop provides similar fixed-column grid layout.' },
    { type: 'blue', text: 'Engine: C++ GridLayout via JSI → ShadowNode applies positions from LayoutCache.' },
  ],
  masonry: [
    { type: 'green', text: 'FlashList: MasonryFlashList available as a separate import. Similar capability.' },
    { type: 'blue', text: 'Engine: C++ MasonryLayout via JSI. Shortest-column placement, Yoga height refinement.' },
  ],
  flow: [
    { type: 'amber', text: 'FlashList: Possible via custom LayoutProvider, but requires manual row-break logic.' },
    { type: 'blue', text: 'Two-pass: estimated sizes → Yoga measures → layout engine reflows. Watch items shift.' },
    { type: 'blue', text: 'Engine: C++ FlowLayout via JSI. ContentDimension=Both (width + height are cell-intrinsic).' },
  ],
  circular: [
    { type: 'red', text: 'FlashList: Not possible. Radial positioning requires arbitrary (x, y) placement.' },
    { type: 'blue', text: 'Scroll vertically to rotate the arc.' },
    { type: 'blue', text: 'Engine: TS custom layout. ContentDimension=None — layout governs everything.' },
  ],
  carousel: [
    { type: 'red', text: 'FlashList: Not possible. Requires per-item perspective transforms and z-ordering.' },
    { type: 'blue', text: 'Scroll horizontally to rotate the carousel.' },
    { type: 'blue', text: 'Engine: TS custom layout. ContentDimension=None — layout governs everything.' },
  ],
};

// ── Sub-tab picker ───────────────────────────────────────────────────────────

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'grid', label: 'Grid' },
  { key: 'masonry', label: 'Masonry' },
  { key: 'flow', label: 'Flow' },
  { key: 'circular', label: 'Radial Arc' },
  { key: 'carousel', label: '3D Carousel' },
];

export default function LayoutsTab() {
  const [subTab, setSubTab] = useState<SubTab>('list');

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
        {subTab === 'list' && <ListDemo />}
        {subTab === 'grid' && <GridDemo />}
        {subTab === 'masonry' && <MasonryDemo />}
        {subTab === 'flow' && <FlowDemo />}

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

  listCell: { minHeight: 72, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
              borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)',
              borderLeftWidth: 4, backgroundColor: 'rgba(255,255,255,0.03)' },
  listCellNum: { fontSize: 14, fontWeight: '700', color: '#888', width: 36 },
  listCellContent: { flex: 1 },
  listCellTitle: { fontSize: 15, fontWeight: '600', color: '#fff' },
  listCellSub: { fontSize: 12, color: '#888', marginTop: 4, lineHeight: 18 },

  gridCell: { height: 100, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  gridCellText: { fontSize: 18, fontWeight: '700', color: '#fff' },

  masonryCell: { flex: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  masonryCellText: { fontSize: 18, fontWeight: '700', color: '#fff' },
  masonryCellSub: { fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 2 },

  flowInfoBar: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#1a1a2a',
                 marginHorizontal: 8, borderRadius: 8, marginBottom: 6 },
  flowInfoText: { fontSize: 11, lineHeight: 16, color: '#93c5fd' },
  flowTag: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
             alignItems: 'center', justifyContent: 'center' },
  flowTagText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  circularCell: { flex: 1, borderRadius: 35, alignItems: 'center', justifyContent: 'center' },
  circularText: { fontSize: 20, fontWeight: '700', color: '#fff' },

  carouselCard: { flex: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                  shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                  shadowOpacity: 0.4, shadowRadius: 12 },
  carouselTitle: { fontSize: 20, fontWeight: '700', color: '#fff' },
});
