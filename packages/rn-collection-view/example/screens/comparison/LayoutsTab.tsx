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
import { Riff as CollectionView, type RiffHandle } from '../../components/CollectionView';
import { list } from '@riff/layouts/list';
import { grid } from '@riff/layouts/grid';
import { masonry } from '@riff/layouts/masonry';
import { flow } from '@riff/layouts/flow';
import { CircularList } from '../../components/CircularList';
import { Carousel3D } from '../../components/Carousel3D';

// ── Shared colors ────────────────────────────────────────────────────────────

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];

// ── List data ────────────────────────────────────────────────────────────────

type ListItem = { id: string; color: string; num: number; subtitle: string; animated?: boolean };

// S0 — Sticky Identity: variable heights, mutation target
const S0_DATA: ListItem[] = Array.from({ length: 25 }, (_, i) => {
  const lineCount = (i % 3) + 1;
  const subtitle = Array(lineCount)
    .fill('Mutation target — variable height for scroll testing.')
    .join('\n');
  return { id: `s0-${i}`, color: COLORS[i % COLORS.length]!, num: i, subtitle };
});

// S1 — Cell Animation Identity: variable heights, every 4th has animated shimmer
const S1_DATA: ListItem[] = Array.from({ length: 25 }, (_, i) => {
  const lineCount = (i % 3) + 1;
  const subtitle = Array(lineCount)
    .fill('Variable height line — Yoga intrinsic measurement.')
    .join('\n');
  return {
    id: `s1-${i}`,
    color: COLORS[i % COLORS.length]!,
    num: i,
    subtitle,
    animated: i % 4 === 0,
  };
});

// S2 — Insets + Spacing: variable heights, annotated with inset values
const S2_DATA: ListItem[] = Array.from({ length: 20 }, (_, i) => {
  const lineCount = (i % 3) + 1;
  const subtitle = Array(lineCount)
    .fill('insets: top 24  bot 24  left 16  right 16  •  spacing: 8px (global)')
    .join('\n');
  return { id: `s2-${i}`, color: COLORS[i % COLORS.length]!, num: i, subtitle };
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

// ── List: shared components ──────────────────────────────────────────────────

/** Counts ms since mount. If this view is never remounted, it never resets. */
function LiveTimer({ style }: { style?: object }) {
  const mountTime = useRef(Date.now()).current;
  return (
    <Text style={[{ fontVariant: ['tabular-nums'] as any }, style]}>
      ⏱ mounted @{mountTime % 100000}
    </Text>
  );
}

/** Shimmer sweep + LiveTimer. For S0 header and footer. Identity proof. */
function ShimmerTimerHeader({ label, color }: { label: string; color: string }) {
  const shimmerX = useRef(new Animated.Value(-120)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(shimmerX, { toValue: 500, duration: 1800, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, [shimmerX]);
  return (
    <View style={{ height: 56, backgroundColor: color, justifyContent: 'center', paddingHorizontal: 16, overflow: 'hidden' }}>
      <Animated.View style={{
        ...StyleSheet.absoluteFillObject,
        width: 100,
        backgroundColor: 'rgba(255,255,255,0.22)',
        transform: [{ translateX: shimmerX }],
      }} />
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{label}</Text>
      <LiveTimer style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11, marginTop: 2 }} />
    </View>
  );
}

/** Timer + "STICKY FOOTER — Riff only" badge. */
function ShimmerTimerFooter({ color }: { color: string }) {
  return (
    <View style={{ height: 40, backgroundColor: color, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, justifyContent: 'space-between' }}>
      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 }}>STICKY FOOTER — RIFF ONLY</Text>
      <LiveTimer style={{ color: 'rgba(255,255,255,0.75)', fontSize: 10 }} />
    </View>
  );
}

/** Compact footer for non-sticky sections — tinted background with colored text. */
function SectionFooter({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ height: 36, backgroundColor: color, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 }}>
      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6, flex: 1 }}>{label.toUpperCase()}</Text>
      <LiveTimer style={{ color: 'rgba(255,255,255,0.75)', fontSize: 10 }} />
    </View>
  );
}

/** Simple timer header for S1/S2. */
function SectionTimerHeader({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ height: 50, backgroundColor: color, justifyContent: 'center', paddingHorizontal: 16 }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{label}</Text>
      <LiveTimer style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 2 }} />
    </View>
  );
}

/**
 * S1 animated cell: shimmer background + mount counter.
 * Mount counter stays at 1 as long as the component is never unmounted.
 * If it goes to 2+, the cell was recycled/remounted (FlashList behavior).
 */
function AnimatedIdentityCell({ item }: { item: ListItem }) {
  const mountCountRef = useRef(0);
  const [mounts, setMounts] = useState(0);
  useEffect(() => {
    mountCountRef.current += 1;
    setMounts(mountCountRef.current);
  }, []);

  const shimmerX = useRef(new Animated.Value(-80)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(shimmerX, { toValue: 400, duration: 1600, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, [shimmerX]);

  const mountsOk = mounts <= 1;
  return (
    <View style={{ backgroundColor: 'rgba(10,10,28,0.50)', borderLeftWidth: 4, borderLeftColor: item.color, paddingHorizontal: 16, paddingVertical: 12, overflow: 'hidden' }}>
      <Animated.View style={{
        ...StyleSheet.absoluteFillObject,
        width: 80,
        backgroundColor: 'rgba(255,255,255,0.07)',
        transform: [{ translateX: shimmerX }],
      }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Item {item.num} ✦</Text>
        <View style={{ backgroundColor: mountsOk ? '#14532d' : '#7f1d1d', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
          <Text style={{ color: mountsOk ? '#4ade80' : '#f87171', fontSize: 10, fontWeight: '700' }}>
            Mounts: {mounts}
          </Text>
        </View>
      </View>
      <Text style={{ color: '#aaa', fontSize: 13, marginTop: 4 }}>{item.subtitle}</Text>
    </View>
  );
}

/** Small control button for the controls bar. */
function CtrlBtn({ label, onPress, disabled, active }: {
  label: string; onPress?: () => void; disabled?: boolean; active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
        backgroundColor: disabled ? '#1a1a1a' : active ? '#1e3a1e' : '#2a2a2a',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: disabled ? '#444' : active ? '#4ade80' : '#ccc', fontSize: 11, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

// ── List layout config ──────────────────────────────────────────────────────

/**
 * Animated section background. Proves a single view lives behind all cells.
 * Slow hue animation: a diagonal gradient band sweeps across continuously.
 */
function AnimatedSectionBg({ sectionIndex, frame }: { sectionIndex: number; frame: { x: number; y: number; width: number; height: number } }) {
  const BASE_HUES = ['#e63946', '#2a9d8f', '#6a4c93'];
  const baseColor = BASE_HUES[sectionIndex % BASE_HUES.length]!;

  const bandX = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(bandX, {
        toValue: 1,
        duration: 6000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ).start();
  }, [bandX]);

  const bandWidth = 120;
  const translateX = bandX.interpolate({
    inputRange:  [0, 1],
    outputRange: [-bandWidth, frame.width + bandWidth],
  });

  return (
    <View style={{ flex: 1, backgroundColor: baseColor + '66', borderRadius: 12, overflow: 'hidden' }}>
      <Animated.View
        style={{
          position: 'absolute',
          top: 0, bottom: 0,
          width: bandWidth,
          backgroundColor: 'rgba(255,255,255,0.18)',
          transform: [{ translateX }],
        }}
      />
    </View>
  );
}

export function ListDemo() {
  // S0 data is mutable — insert / delete / resize act on it
  const [s0Items, setS0Items] = useState<ListItem[]>(S0_DATA);
  const [resizedIds, setResizedIds] = useState<Set<string>>(() => new Set());
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const [sepEnabled, setSepEnabled] = useState(false);
  const [decoCount, setDecoCount] = useState(0);
  const insertCounter = useRef(S0_DATA.length);
  const cvRef = useRef<RiffHandle>(null);

  const listLayout = useMemo(() => list({
    estimatedItemHeight: 56,
    itemSpacing: 2,
    sectionSpacing: 20,
    separator: sepEnabled ? { color: '#4a4a6a', insetLeading: 16 } : undefined,
    sectionBackground: true,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sepEnabled]);

  // ── Mutation handlers ──────────────────────────────────────────────────────

  const handleInsert = useCallback(() => {
    const newItems: ListItem[] = Array.from({ length: 3 }, () => {
      const idx = insertCounter.current++;
      return {
        id: `s0-ins-${idx}`,
        color: COLORS[idx % COLORS.length]!,
        num: idx,
        subtitle: 'Inserted above — scroll down first to see MVC in action (L5).',
      };
    });
    setS0Items(prev => [...newItems, ...prev]);
  }, []);

  const handleDelete = useCallback(() => {
    setS0Items(prev => prev.length >= 3 ? prev.slice(3) : prev);
  }, []);

  const toggleResize = useCallback((id: string) => {
    setResizedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const resizeS0First = useCallback(() => {
    if (s0Items.length > 0) toggleResize(s0Items[0]!.id);
  }, [s0Items, toggleResize]);

  const resizeS1First = useCallback(() => toggleResize('s1-0'), [toggleResize]);
  const resizeS2Last  = useCallback(() => toggleResize('s2-19'), [toggleResize]);

  // ── Sections ───────────────────────────────────────────────────────────────

  const sections = useMemo(() => [
    {
      key: 'sticky-identity',
      data: s0Items,
      header: {
        render: () => <ShimmerTimerHeader label="S0 — Sticky Identity" color="#e63946" />,
        height: 56,
        sticky: true,
      },
      footer: {
        render: () => <ShimmerTimerFooter color="#e63946" />,
        height: 40,
        sticky: true,
      },
      insets: { top: 8, bottom: 8, left: 12, right: 12 },
    },
    {
      key: 'cell-animation',
      data: S1_DATA,
      header: {
        render: () => <SectionTimerHeader label="S1 — Cell Animation Identity" color="#2a9d8f" />,
        height: 50,
        sticky: true,
      },
      footer: {
        render: () => <SectionFooter color="#2a9d8f" label="End of S1 — Cell Animation" />,
        height: 36,
        sticky: true,
      },
      insets: { top: 8, bottom: 8, left: 12, right: 12 },
    },
    {
      key: 'insets-spacing',
      data: S2_DATA,
      header: {
        render: () => <SectionTimerHeader label="S2 — Insets + Spacing" color="#6a4c93" />,
        height: 50,
        sticky: true,
      },
      footer: {
        render: () => <SectionFooter color="#6a4c93" label="End of S2 — Insets + Spacing" />,
        height: 36,
        sticky: true,
      },
      insets: { top: 8, bottom: 8, left: 16, right: 16 },
    },
  ], [s0Items]);

  // ── renderItem ─────────────────────────────────────────────────────────────

  const keyExtractor = useCallback((item: ListItem) => item.id, []);

  const RESIZE_SUBTITLE = 'Resized to tall.\nLine 2 — height change triggers layout invalidation.\nLine 3 — ShadowNode corrects downstream positions in same commit.\nLine 4 — no scroll jump.';

  const renderItem = useCallback(({ item, sectionIndex }: { item: ListItem; sectionIndex: number; itemIndex: number }) => {
    const isResized = resizedIds.has(item.id);
    const subtitle = isResized ? RESIZE_SUBTITLE : item.subtitle;

    if (sectionIndex === 1 && item.animated && !isResized) {
      return <AnimatedIdentityCell item={item} />;
    }

    const textColor = sectionIndex === 2 ? '#c4b5fd' : '#aaa';
    return (
      <View style={{ backgroundColor: 'rgba(10,10,28,0.50)', borderLeftWidth: 4, borderLeftColor: item.color, paddingHorizontal: 16, paddingVertical: 12 }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Item {item.num}</Text>
        <Text style={{ color: textColor, fontSize: 13, marginTop: 4 }}>{subtitle}</Text>
      </View>
    );
  }, [resizedIds]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <AnimatedSectionBg sectionIndex={sectionIndex} frame={frame} />
    ),
  }), []);

  return (
    <View style={S.flex}>
      {/* Controls bar — horizontal scroll */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.ctrlBarScroll} contentContainerStyle={S.ctrlBar}>
        <CtrlBtn label="→ Top" onPress={() => cvRef.current?.scrollToOffset({ y: 0 })} />
        <CtrlBtn label="→ #42" onPress={() => cvRef.current?.scrollToItem('cell-animation:s1-17', { position: 'center' })} />
        <CtrlBtn label="→ Bot" onPress={() => cvRef.current?.scrollToItem('insets-spacing:s2-19', { position: 'bottom' })} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="+Insert" onPress={handleInsert} />
        <CtrlBtn label="×Delete" onPress={handleDelete} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="↕S0[0]" onPress={resizeS0First} active={s0Items.length > 0 && resizedIds.has(s0Items[0]!.id)} />
        <CtrlBtn label="↕S1[0]" onPress={resizeS1First} active={resizedIds.has('s1-0')} />
        <CtrlBtn label="↕S2[-1]" onPress={resizeS2Last} active={resizedIds.has('s2-19')} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label={mvcEnabled ? 'MVC: ON' : 'MVC: OFF'} onPress={() => setMvcEnabled(v => !v)} active={mvcEnabled} />
        <CtrlBtn label={sepEnabled ? 'Sep: ON' : 'Sep: OFF'} onPress={() => setSepEnabled(v => !v)} active={sepEnabled} />
        <View style={{ paddingHorizontal: 6, justifyContent: 'center' }}>
          <Text style={{ color: '#888', fontSize: 10, fontWeight: '600' }}>Deco:{decoCount}</Text>
        </View>
      </ScrollView>

      <CollectionView
        handle={cvRef}
        sections={sections}
        layout={listLayout}
        stickyMode="push"
        estimatedItemHeight={56}
        extraData={resizedIds}
        scrollViewProps={{ style: { backgroundColor: '#2a2a3e' }, indicatorStyle: 'white' }}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        maintainVisibleContentPosition={mvcEnabled}
        decorationRenderers={decorationRenderers}
        onDecorationCountChange={setDecoCount}
      />
    </View>
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
    { type: 'green', text: 'S0: Header + footer timers survive all scroll — same view instance repositioned natively, never remounted. FlashList: no sticky footer.' },
    { type: 'red', text: 'FlashList: Recycled cell re-mounts → shimmer restarts from frame 0, mount counter increments. No sticky footer support.' },
    { type: 'blue', text: 'S1: Shimmer continues from same phase after scroll-away (Activity=hidden preserves state). Mount counter badge stays green at 1.' },
    { type: 'blue', text: 'S2: Per-section insets (top/bot 24, left/right 16) from C++ ListLayout. Item spacing is 8px global.' },
    { type: 'blue', text: 'Controls: +Insert/×Delete/↕Resize mutate S0 data with MVC toggle. →Top/→#42/→Bot scroll to items by stable key.' },
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
  const [calloutsOpen, setCalloutsOpen] = useState(false);

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
              onPress={() => { setSubTab(t.key); setCalloutsOpen(false); }}
            >
              <Text style={[S.pickText, subTab === t.key && S.pickTextActive]}>
                {t.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      <Pressable style={S.calloutsToggle} onPress={() => setCalloutsOpen(o => !o)}>
        <Text style={S.calloutsToggleText}>ℹ {bullets.length} notes</Text>
        <Text style={S.calloutsToggleChevron}>{calloutsOpen ? '▲' : '▼'}</Text>
      </Pressable>

      {calloutsOpen && (
        <View style={S.bulletsContainer}>
          {bullets.map((b, i) => (
            <View key={i} style={[S.bullet, S[`bullet_${b.type}` as keyof typeof S] as any]}>
              <Text style={[S.bulletText, S[`bulletText_${b.type}` as keyof typeof S] as any]}>
                {b.text}
              </Text>
            </View>
          ))}
        </View>
      )}

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

  calloutsToggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 5, backgroundColor: '#111' },
  calloutsToggleText: { fontSize: 11, color: '#555' },
  calloutsToggleChevron: { fontSize: 9, color: '#444' },

  bulletsContainer: { paddingHorizontal: 8, gap: 4, paddingBottom: 6, backgroundColor: '#0a0a0a' },
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

  ctrlBarScroll: { backgroundColor: '#111', flexGrow: 0 },
  ctrlBar: { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 7, alignItems: 'center' },
  ctrlDivider: { width: 1, height: 18, backgroundColor: '#333', marginHorizontal: 2 },

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

// ── Horizontal list demo ──────────────────────────────────────────────────────

/**
 * Variable-height product cards for horizontal list demo.
 * Heights are content-determined by Yoga — the list grows to fit the tallest
 * card it has measured. Cards with more lines / tags are naturally taller.
 */
type HCard = {
  id: string;
  color: string;
  num: number;
  label: string;
  description: string;   // variable length — drives height variance
  tags: string[];        // 0-3 tags — additional height variance
};

const H_COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4', '#06d6a0', '#ef476f'];

const DESCRIPTIONS = [
  '',
  'A fine specimen worth examining.',
  'Bold, vivid, and full of character.\nOne of a kind.',
  'Curated with care.\nLimited availability.\nHighly recommended.',
];
const TAG_POOLS = [[], ['new'], ['sale', 'hot'], ['featured', 'trending', 'limited']];

const makeHSections = () => [
  {
    key: 'nature',
    label: '🌿 Nature',
    items: Array.from({ length: 12 }, (_, i) => ({
      id: `nature-${i}`,
      color: H_COLORS[i % H_COLORS.length]!,
      num: i,
      label: `Nature ${i + 1}`,
      description: DESCRIPTIONS[i % DESCRIPTIONS.length]!,
      tags: TAG_POOLS[i % TAG_POOLS.length]!,
    })),
  },
  {
    key: 'cities',
    label: '🏙 Cities',
    items: Array.from({ length: 10 }, (_, i) => ({
      id: `city-${i}`,
      color: H_COLORS[(i + 3) % H_COLORS.length]!,
      num: i,
      label: `City ${i + 1}`,
      description: DESCRIPTIONS[(i + 2) % DESCRIPTIONS.length]!,
      tags: TAG_POOLS[(i + 1) % TAG_POOLS.length]!,
    })),
  },
  {
    key: 'abstract',
    label: '🎨 Abstract',
    items: Array.from({ length: 15 }, (_, i) => ({
      id: `abs-${i}`,
      color: H_COLORS[(i + 6) % H_COLORS.length]!,
      num: i,
      label: `Art ${i + 1}`,
      description: DESCRIPTIONS[(i + 1) % DESCRIPTIONS.length]!,
      tags: TAG_POOLS[(i + 2) % TAG_POOLS.length]!,
    })),
  },
];

// Section metadata for headers/footers
const H_SECTIONS_META: { key: string; label: string; icon: string; color: string }[] = [
  { key: 'nature',   label: 'Nature',   icon: '🌿', color: '#0f2a1a' },
  { key: 'cities',   label: 'Cities',   icon: '🏙', color: '#0a1a2a' },
  { key: 'abstract', label: 'Abstract', icon: '🎨', color: '#1a0a2a' },
];

export function HorizontalListDemo() {
  const sections = useMemo(() => makeHSections(), []);

  const riffSections = sections.map((s, sIdx) => {
    const meta = H_SECTIONS_META[sIdx]!;
    return {
      key: s.key,
      data: s.items,
      header: {
        render: () => (
          // flex: 1 fills the native-positioned frame (full cross-axis height set by applyMeasurements)
          <View style={[HS.sectionHeader, { backgroundColor: meta.color }]}>
            <View style={HS.sectionHeaderIcon}>
              <Text style={HS.sectionHeaderEmoji}>{meta.icon}</Text>
            </View>
            <Text style={HS.sectionHeaderTitle}>{meta.label}</Text>
            <Text style={HS.sectionHeaderCount}>{s.items.length} items</Text>
          </View>
        ),
        height: 80,   // primary-axis width of header strip
        sticky: true,
      },
      footer: {
        render: () => (
          <View style={[HS.sectionFooter, { backgroundColor: meta.color }]}>
            <Text style={HS.sectionFooterIcon}>{meta.icon}</Text>
            <Text style={HS.sectionFooterLabel}>End</Text>
          </View>
        ),
        height: 50,   // primary-axis width of footer strip
        sticky: true,
      },
      insets: { top: 10, bottom: 10, left: 12, right: 12 },
    };
  });

  const hLayout = useMemo(() => list({
    horizontal: true,
    itemHeight: 130,              // estimated card width (primary axis); Yoga measures final
    estimatedCrossAxisHeight: 140, // estimated card height (cross axis); Yoga measures final
    itemSpacing: 10,
    sectionSpacing: 4,
    sectionBackground: true,
  }), []);

  const renderCard = useCallback(({ item }: { item: HCard }) => (
    <View style={[HS.card, { backgroundColor: item.color + 'cc' }]}>
      {/* Thumbnail placeholder — 100×100 */}
      <View style={HS.cardThumb}>
        <Text style={HS.cardThumbNum}>{item.num + 1}</Text>
      </View>
      <Text style={HS.cardLabel}>{item.label}</Text>
      {item.description.length > 0 && (
        <Text style={HS.cardDesc}>{item.description}</Text>
      )}
      {item.tags.length > 0 && (
        <View style={HS.tagRow}>
          {item.tags.map(t => (
            <View key={t} style={HS.tag}>
              <Text style={HS.tagText}>{t}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  ), []);

  return (
    <View style={{ flex: 1, backgroundColor: '#0a0a0a' }}>
      <View style={HS.titleBar}>
        <Text style={HS.title}>Horizontal List</Text>
        <Text style={HS.subtitle}>3 sections · variable-height cards · list grows to tallest measured card</Text>
      </View>
      {/* List background + content-determined height container */}
      <View style={HS.listBackground}>
        <CollectionView
          sections={riffSections}
          layout={hLayout}
          renderItem={renderCard}
          keyExtractor={(item: HCard) => item.id}
          estimatedItemHeight={140}
          scrollViewProps={{ style: { backgroundColor: 'transparent' } }}
        />
      </View>
    </View>
  );
}

const HS = StyleSheet.create({
  titleBar:           { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  title:              { fontSize: 15, fontWeight: '700', color: '#e2e8f0' },
  subtitle:           { fontSize: 11, color: '#475569', marginTop: 2 },

  listBackground:     { flex: 1, backgroundColor: '#161616', marginHorizontal: 0,
                        borderRadius: 0, overflow: 'hidden' },

  // Section header — full cross-axis height via flex:1
  sectionHeader:      { flex: 1, alignItems: 'center', justifyContent: 'center',
                        paddingHorizontal: 12 },
  sectionHeaderIcon:  { width: 100, height: 100, borderRadius: 16,
                        backgroundColor: 'rgba(255,255,255,0.08)',
                        alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  sectionHeaderEmoji: { fontSize: 44 },
  sectionHeaderTitle: { fontSize: 14, fontWeight: '700', color: '#e2e8f0', textAlign: 'center' },
  sectionHeaderCount: { fontSize: 11, color: '#64748b', marginTop: 4 },

  // Section footer
  sectionFooter:      { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  sectionFooterIcon:  { fontSize: 22, marginBottom: 4 },
  sectionFooterLabel: { fontSize: 10, color: '#475569', fontWeight: '600' },

  // Cards
  card:               { borderRadius: 14, alignItems: 'center', paddingHorizontal: 10,
                        paddingVertical: 12, margin: 3 },
  cardThumb:          { width: 100, height: 100, borderRadius: 12,
                        backgroundColor: 'rgba(0,0,0,0.25)',
                        alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  cardThumbNum:       { fontSize: 32, fontWeight: '800', color: '#fff' },
  cardLabel:          { fontSize: 11, color: 'rgba(255,255,255,0.85)', textAlign: 'center',
                        fontWeight: '600' },
  cardDesc:           { fontSize: 10, color: 'rgba(255,255,255,0.55)', marginTop: 5,
                        textAlign: 'center', lineHeight: 14 },
  tagRow:             { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8,
                        justifyContent: 'center' },
  tag:                { backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 4,
                        paddingHorizontal: 6, paddingVertical: 2 },
  tagText:            { fontSize: 9, color: '#fff', fontWeight: '600', textTransform: 'uppercase' },
});
