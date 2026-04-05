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

type GridCell = { id: string; color: string; num: number; height?: number };

// S2 uses varying heights to demonstrate uneven rows (row height = tallest item)
const GS2_HEIGHTS = [60, 110, 80, 130, 70, 100, 90, 120, 65, 95, 115, 75];

// 3 sections of fixed-height cells — each section uses COLORS rotated
const GS0_DATA: GridCell[] = Array.from({ length: 18 }, (_, i) => ({
  id: `gs0-${i}`, color: COLORS[i % COLORS.length]!, num: i,
}));
const GS1_DATA: GridCell[] = Array.from({ length: 12 }, (_, i) => ({
  id: `gs1-${i}`, color: COLORS[(i + 2) % COLORS.length]!, num: i,
}));
const GS2_DATA: GridCell[] = Array.from({ length: 24 }, (_, i) => ({
  id: `gs2-${i}`, color: COLORS[(i + 5) % COLORS.length]!, num: i,
  height: GS2_HEIGHTS[i % GS2_HEIGHTS.length],
}));

// ── Masonry data ─────────────────────────────────────────────────────────────

type MasonryItem = { id: string; height: number; color: string; num: number; section: number };

function makeMasonrySection(prefix: string, sectionIdx: number, count: number): MasonryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    height: 70 + Math.floor(Math.random() * 130),
    color: COLORS[(i + sectionIdx * 3) % COLORS.length]!,
    num: i,
    section: sectionIdx,
  }));
}

const MS0_INIT = makeMasonrySection('ms0', 0, 20);
const MS1_DATA = makeMasonrySection('ms1', 1, 16);
const MS2_DATA = makeMasonrySection('ms2', 2, 24);

const MS_HDR_H = 44;
const MS_FTR_H = 28;

function MasonrySectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ height: MS_HDR_H, backgroundColor: color + 'dd', justifyContent: 'center', paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: color }}>
      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

function MasonrySectionFooter({ color, count }: { color: string; count: number }) {
  return (
    <View style={{ height: MS_FTR_H, backgroundColor: color + '44', justifyContent: 'center', paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: color + '88' }}>
      <Text style={{ color, fontSize: 11, fontWeight: '600' }}>{count} items</Text>
    </View>
  );
}

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
    // L3.1: jacket effect — bg expands 8pt above header + below footer.
    sectionBackgroundContentInsets: { top: -8, bottom: -8 },
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

const GRID_HDR_H  = 44;
const GRID_FTR_H  = 28;
const GRID_ROW_H  = 90;

function GridSectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ height: GRID_HDR_H, backgroundColor: color + 'dd', justifyContent: 'center', paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: color }}>
      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

function GridSectionFooter({ color, count }: { color: string; count: number }) {
  return (
    <View style={{ height: GRID_FTR_H, backgroundColor: color + '44', justifyContent: 'center', paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: color + '88' }}>
      <Text style={{ color: color, fontSize: 11, fontWeight: '600' }}>{count} items</Text>
    </View>
  );
}

export function GridDemo() {
  const cvRef = useRef<any>(null);
  const [gs0Items, setGs0Items] = useState<GridCell[]>(GS0_DATA);
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const [sepEnabled, setSepEnabled] = useState(false);
  const [decoCount, setDecoCount] = useState(0);
  const [resizedIds, setResizedIds] = useState(() => new Set<string>());
  const insertCounter = useRef(GS0_DATA.length);
  // Ref mirrors resizedIds so heightForItem closure always reads current value.
  const resizedIdsRef = useRef(resizedIds);
  resizedIdsRef.current = resizedIds;

  // Always use heightForItem — S2 has varying heights, S0/S1 use GRID_ROW_H (or 2× when resized).
  // Row height = max of items in that row, demonstrating uneven items in a row.
  const gridLayout = useMemo(() => grid({
    columns: 3,
    heightForItem: (i: number, s: number) => {
      const allSections = [gs0Items, GS1_DATA, GS2_DATA];
      const item = allSections[s]?.[i];
      if (!item) return GRID_ROW_H;
      if (resizedIdsRef.current.has(item.id)) return GRID_ROW_H * 2;
      return item.height ?? GRID_ROW_H;
    },
    columnSpacing: 6,
    rowSpacing: 6,
    sectionSpacing: 16,
    sectionBackground: true,
    separator: sepEnabled ? { color: '#ff3b30', height: 0.5 } : undefined,
  }), [sepEnabled, resizedIds, gs0Items]);

  const keyExtractor = useCallback((item: GridCell) => item.id, []);

  const handleInsert = useCallback(() => {
    const newItems: GridCell[] = Array.from({ length: 3 }, () => {
      const idx = insertCounter.current++;
      return { id: `gs0-ins-${idx}`, color: COLORS[idx % COLORS.length]!, num: idx };
    });
    setGs0Items(prev => [...newItems, ...prev]);
  }, []);

  const handleDelete = useCallback(() => {
    setGs0Items(prev => prev.length >= 3 ? prev.slice(3) : prev);
  }, []);

  const handleInsert1 = useCallback(() => {
    const idx = insertCounter.current++;
    setGs0Items(prev => [{ id: `gs0-ins-${idx}`, color: COLORS[idx % COLORS.length]!, num: idx }, ...prev]);
  }, []);

  const handleDelete1 = useCallback(() => {
    setGs0Items(prev => prev.length >= 1 ? prev.slice(1) : prev);
  }, []);

  const toggleResize = useCallback((id: string) => {
    setResizedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const sections = useMemo(() => [
    {
      key: 'gs0',
      data: gs0Items,
      header: {
        render: () => <GridSectionHeader label={`S0 — Photos (${gs0Items.length})`} color="#e63946" />,
        height: GRID_HDR_H,
        sticky: true,
      },
      footer: {
        render: () => <GridSectionFooter color="#e63946" count={gs0Items.length} />,
        height: GRID_FTR_H,
        sticky: true,
      },
      insets: { top: 6, bottom: 6, left: 8, right: 8 },
    },
    {
      key: 'gs1',
      data: GS1_DATA,
      header: {
        render: () => <GridSectionHeader label="S1 — Documents (12)" color="#2a9d8f" />,
        height: GRID_HDR_H,
        sticky: true,
      },
      footer: {
        render: () => <GridSectionFooter color="#2a9d8f" count={GS1_DATA.length} />,
        height: GRID_FTR_H,
        sticky: true,
      },
      insets: { top: 6, bottom: 6, left: 8, right: 8 },
    },
    {
      key: 'gs2',
      data: GS2_DATA,
      header: {
        render: () => <GridSectionHeader label="S2 — Archive (24)" color="#6a4c93" />,
        height: GRID_HDR_H,
        sticky: true,
      },
      footer: {
        render: () => <GridSectionFooter color="#6a4c93" count={GS2_DATA.length} />,
        height: GRID_FTR_H,
        sticky: true,
      },
      insets: { top: 6, bottom: 6, left: 8, right: 8 },
    },
  ], [gs0Items]);

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <AnimatedSectionBg sectionIndex={sectionIndex} frame={frame} />
    ),
  }), []);

  const renderItem = useCallback(({ item }: { item: GridCell }) => {
    const isResized = resizedIds.has(item.id);
    const cellHeight = isResized ? GRID_ROW_H * 2 : (item.height ?? GRID_ROW_H);
    return (
      <Pressable
        style={[S.gridCell, { borderColor: item.color, height: cellHeight }]}
        onPress={() => toggleResize(item.id)}
      >
        <Text style={[S.gridCellText, { color: item.color }]}>{item.num}</Text>
        {item.height && !isResized && (
          <Text style={{ color: item.color, fontSize: 9, opacity: 0.7 }}>{item.height}px</Text>
        )}
        {isResized && <Text style={{ color: item.color, fontSize: 9, opacity: 0.7 }}>↕ tall</Text>}
      </Pressable>
    );
  }, [resizedIds, toggleResize]);

  return (
    <View style={S.flex}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.ctrlBarScroll} contentContainerStyle={S.ctrlBar}>
        <CtrlBtn label="→ Top" onPress={() => cvRef.current?.scrollToOffset({ y: 0 })} />
        <CtrlBtn label="→ S1" onPress={() => cvRef.current?.scrollToItem('gs1:gs1-0', { position: 'top' })} />
        <CtrlBtn label="→ Bot" onPress={() => cvRef.current?.scrollToItem('gs2:gs2-23', { position: 'bottom' })} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="+1" onPress={handleInsert1} />
        <CtrlBtn label="−1" onPress={handleDelete1} />
        <CtrlBtn label="+3" onPress={handleInsert} />
        <CtrlBtn label="−3" onPress={handleDelete} />
        <CtrlBtn label="↕ S0[0]" onPress={() => { const id = gs0Items[0]?.id; if (id) toggleResize(id); }} />
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
        layout={gridLayout}
        stickyMode="push"
        estimatedItemHeight={GRID_ROW_H}
        extraData={resizedIds}
        maintainVisibleContentPosition={mvcEnabled}
        decorationRenderers={decorationRenderers}
        onDecorationCountChange={setDecoCount}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
      />
    </View>
  );
}

// ── Masonry layout config ───────────────────────────────────────────────────

export function MasonryDemo() {
  const cvRef = useRef<any>(null);
  const [ms0Items, setMs0Items] = useState<MasonryItem[]>(MS0_INIT);
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const [sepEnabled, setSepEnabled] = useState(false);
  const [decoCount, setDecoCount] = useState(0);
  const [resizedIds, setResizedIds] = useState(() => new Set<string>());
  const insertCounter = useRef(MS0_INIT.length);
  const resizedIdsRef = useRef(resizedIds);
  resizedIdsRef.current = resizedIds;

  const allSectionsRef = useRef<MasonryItem[][]>([ms0Items, MS1_DATA, MS2_DATA]);
  allSectionsRef.current = [ms0Items, MS1_DATA, MS2_DATA];

  const masonryLayout = useMemo(() => masonry({
    columns: 2,
    columnSpacing: 8,
    rowSpacing: 8,
    sectionSpacing: 16,
    sectionBackground: true,
    separator: sepEnabled ? { color: '#334', height: 0.5 } : undefined,
    heightForItem: (i: number, s: number) => {
      const item = allSectionsRef.current[s]?.[i];
      if (!item) return 100;
      return resizedIdsRef.current.has(item.id) ? item.height * 1.5 : item.height;
    },
  }), [sepEnabled, resizedIds, ms0Items]);

  const keyExtractor = useCallback((item: MasonryItem) => item.id, []);

  const handleInsert = useCallback(() => {
    setMs0Items(prev => {
      const idx = insertCounter.current++;
      return [{ id: `ms0-ins-${idx}`, height: 70 + Math.floor(Math.random() * 130),
                color: COLORS[idx % COLORS.length]!, num: idx, section: 0 }, ...prev];
    });
  }, []);

  const handleDelete = useCallback(() => {
    setMs0Items(prev => prev.length >= 1 ? prev.slice(1) : prev);
  }, []);

  const toggleResize = useCallback((id: string) => {
    setResizedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const sections = useMemo(() => [
    {
      key: 'ms0', data: ms0Items,
      header: { render: () => <MasonrySectionHeader label={`S0 — Photos (${ms0Items.length})`} color="#e63946" />, height: MS_HDR_H, sticky: true },
      footer: { render: () => <MasonrySectionFooter color="#e63946" count={ms0Items.length} />, height: MS_FTR_H, sticky: true },
      insets: { top: 8, bottom: 8, left: 8, right: 8 },
    },
    {
      key: 'ms1', data: MS1_DATA,
      header: { render: () => <MasonrySectionHeader label="S1 — Art (16)" color="#2a9d8f" />, height: MS_HDR_H, sticky: true },
      footer: { render: () => <MasonrySectionFooter color="#2a9d8f" count={MS1_DATA.length} />, height: MS_FTR_H, sticky: true },
      insets: { top: 8, bottom: 8, left: 8, right: 8 },
    },
    {
      key: 'ms2', data: MS2_DATA,
      header: { render: () => <MasonrySectionHeader label="S2 — Archive (24)" color="#6a4c93" />, height: MS_HDR_H, sticky: true },
      footer: { render: () => <MasonrySectionFooter color="#6a4c93" count={MS2_DATA.length} />, height: MS_FTR_H, sticky: true },
      insets: { top: 8, bottom: 8, left: 8, right: 8 },
    },
  ], [ms0Items]);

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <AnimatedSectionBg sectionIndex={sectionIndex} frame={frame} />
    ),
  }), []);

  const renderItem = useCallback(({ item }: { item: MasonryItem }) => {
    const isResized = resizedIds.has(item.id);
    const h = isResized ? Math.round(item.height * 1.5) : item.height;
    return (
      <Pressable style={[S.masonryCell, { backgroundColor: item.color, height: h }]} onPress={() => toggleResize(item.id)}>
        <Text style={S.masonryCellText}>{item.num}</Text>
        <Text style={S.masonryCellSub}>{h}px{isResized ? ' ↕' : ''}</Text>
      </Pressable>
    );
  }, [resizedIds, toggleResize]);

  return (
    <View style={S.flex}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.ctrlBarScroll} contentContainerStyle={S.ctrlBar}>
        <CtrlBtn label="→ Top" onPress={() => cvRef.current?.scrollToOffset({ y: 0 })} />
        <CtrlBtn label="→ S1" onPress={() => cvRef.current?.scrollToItem('ms1:ms1-0', { position: 'top' })} />
        <CtrlBtn label="→ Bot" onPress={() => cvRef.current?.scrollToItem('ms2:ms2-23', { position: 'bottom' })} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="+1" onPress={handleInsert} />
        <CtrlBtn label="−1" onPress={handleDelete} />
        <CtrlBtn label="↕ S0[0]" onPress={() => { const id = ms0Items[0]?.id; if (id) toggleResize(id); }} />
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
        layout={masonryLayout}
        stickyMode="push"
        estimatedItemHeight={120}
        extraData={resizedIds}
        maintainVisibleContentPosition={mvcEnabled}
        decorationRenderers={decorationRenderers}
        onDecorationCountChange={setDecoCount}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
      />
    </View>
  );
}

// ── Horizontal Masonry ────────────────────────────────────────────────────────

const HM_COLS = 3;          // number of horizontal lanes (rows)
const HM_ESTIMATED_H = 150; // initial container height estimate

type HMItem = { id: string; color: string; num: number; label: string };

function makeHMSection(prefix: string, count: number, colorOffset: number): HMItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    color: COLORS[(i + colorOffset) % COLORS.length]!,
    num: i,
    label: `${prefix.split('-')[1]} #${i + 1}`,
  }));
}

const HM_S0_INIT = makeHMSection('hm-s0', 15, 0);
const HM_S1_DATA = makeHMSection('hm-s1', 12, 3);

export function HMasonryDemo() {
  const cvRef = useRef<any>(null);
  const [s0Items, setS0Items] = useState<HMItem[]>(HM_S0_INIT);
  const [containerH, setContainerH] = useState(HM_ESTIMATED_H);
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const insertCounter = useRef(HM_S0_INIT.length);

  const hmLayout = useMemo(() => masonry({
    horizontal: true,
    columns: HM_COLS,
    estimatedCrossAxisHeight: HM_ESTIMATED_H,
    columnSpacing: 8,
    rowSpacing: 8,
    sectionSpacing: 16,
    sectionBackground: true,
    // heightForItem unused in H-mode (Yoga measures; heights are uniform across all items)
    heightForItem: () => 0,
  }), []);

  const handleInsert = useCallback(() => {
    const idx = insertCounter.current++;
    setS0Items(prev => [{
      id: `hm-s0-ins-${idx}`, color: COLORS[idx % COLORS.length]!,
      num: idx, label: `New #${idx + 1}`,
    }, ...prev]);
  }, []);

  const handleDelete = useCallback(() => {
    setS0Items(prev => prev.length >= 1 ? prev.slice(1) : prev);
  }, []);

  const sections = useMemo(() => [
    {
      key: 'hm-s0', data: s0Items,
      header: {
        render: () => (
          <View style={[HMS.sectionHeader, { backgroundColor: '#e63946' }]}>
            <Text style={HMS.sectionHeaderTitle}>{'S0'.split('').join('\n')}</Text>
          </View>
        ),
        height: 20, sticky: true,
      },
      footer: {
        render: () => (
          <View style={[HMS.sectionFooter, { backgroundColor: '#e63946' }]}>
            <Text style={HMS.sectionFooterLabel}>{'END'.split('').join('\n')}</Text>
          </View>
        ),
        height: 20, sticky: true,
      },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'hm-s1', data: HM_S1_DATA,
      header: {
        render: () => (
          <View style={[HMS.sectionHeader, { backgroundColor: '#2a9d8f' }]}>
            <Text style={HMS.sectionHeaderTitle}>{'S1'.split('').join('\n')}</Text>
          </View>
        ),
        height: 20, sticky: true,
      },
      footer: {
        render: () => (
          <View style={[HMS.sectionFooter, { backgroundColor: '#2a9d8f' }]}>
            <Text style={HMS.sectionFooterLabel}>{'END'.split('').join('\n')}</Text>
          </View>
        ),
        height: 20, sticky: true,
      },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
  ], [s0Items]);

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <AnimatedSectionBg sectionIndex={sectionIndex} frame={frame} />
    ),
  }), []);

  const renderItem = useCallback(({ item }: { item: HMItem }) => (
    <View style={[HMS.card, { backgroundColor: item.color + 'cc' }]}>
      <Text style={HMS.cardNum}>{item.num + 1}</Text>
      <Text style={HMS.cardLabel}>{item.label}</Text>
    </View>
  ), []);

  const keyExtractor = useCallback((item: HMItem) => item.id, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#0a0a0a' }}>
      <View style={HMS.titleBar}>
        <Text style={HMS.title}>H-Masonry ({HM_COLS} lanes · shortest-lane placement)</Text>
        <Text style={HMS.subtitle}>Container height auto-sizes — currently {Math.round(containerH)}pt</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={HMS.ctrlBar} contentContainerStyle={HMS.ctrlBarContent}>
        <CtrlBtn label="← Start" onPress={() => cvRef.current?.scrollToOffset({ x: 0 })} />
        <CtrlBtn label="→ S1" onPress={() => cvRef.current?.scrollToItem('hm-s1:hm-s1-0', { position: 'start' })} />
        <CtrlBtn label="→ End" onPress={() => cvRef.current?.scrollToItem('hm-s1:hm-s1-11', { position: 'end' })} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="+1" onPress={handleInsert} />
        <CtrlBtn label="−1" onPress={handleDelete} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label={mvcEnabled ? 'MVC: ON' : 'MVC: OFF'} onPress={() => setMvcEnabled(v => !v)} active={mvcEnabled} />
      </ScrollView>

      <View style={[HMS.listBg, { height: containerH }]}>
        <CollectionView
          handle={cvRef}
          sections={sections}
          layout={hmLayout}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          estimatedItemHeight={HM_ESTIMATED_H}
          maintainVisibleContentPosition={mvcEnabled}
          decorationRenderers={decorationRenderers}
          scrollViewProps={{
            style: { backgroundColor: 'transparent' },
            indicatorStyle: 'white',
            onContentSizeChange: (_w: number, h: number) => {
              if (h > 0) setContainerH(prev => Math.abs(prev - h) > 2 ? h : prev);
            },
          }}
        />
      </View>
    </View>
  );
}

const HMS = StyleSheet.create({
  titleBar:       { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  title:          { fontSize: 15, fontWeight: '700', color: '#e2e8f0' },
  subtitle:       { fontSize: 11, color: '#475569', marginTop: 2 },

  ctrlBar:        { backgroundColor: '#111', flexGrow: 0 },
  ctrlBarContent: { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 7, alignItems: 'center' },

  listBg:         { backgroundColor: '#0f1623', overflow: 'hidden' },

  sectionHeader:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionHeaderTitle: { fontSize: 8, fontWeight: '700', color: 'rgba(255,255,255,0.7)', textAlign: 'center', lineHeight: 10 },
  sectionFooter:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionFooterLabel: { fontSize: 8, color: 'rgba(255,255,255,0.5)', fontWeight: '600', textAlign: 'center', lineHeight: 10 },

  card:           { borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 8, margin: 4 },
  cardNum:        { fontSize: 22, fontWeight: '800', color: '#fff' },
  cardLabel:      { fontSize: 10, color: 'rgba(255,255,255,0.85)', fontWeight: '600', textAlign: 'center', marginTop: 4 },
});

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

type SubTab = 'list' | 'grid' | 'hgrid' | 'ahgrid' | 'masonry' | 'hmasonry' | 'flow' | 'circular' | 'carousel';

// ── Callout bullets per layout ───────────────────────────────────────────────
type Bullet = { type: 'green' | 'amber' | 'red' | 'blue'; text: string };

const CALLOUTS: Record<SubTab, Bullet[]> = {
  hgrid: [
    { type: 'green', text: 'FlashList: No built-in horizontal grid. Requires manual row-grouping and numColumns workaround.' },
    { type: 'blue', text: 'columns=2 → items tile top→bottom in column-groups, scroll left→right. C++ GridLayout horizontal path.' },
    { type: 'blue', text: 'Sticky headers/footers are narrow vertical strips (20px wide). Section backgrounds span column-groups.' },
    { type: 'blue', text: 'Row separators (horizontal lines within a column-group) and column-group separators (vertical lines between groups) toggled independently.' },
  ],
  ahgrid: [
    { type: 'green', text: 'FlashList: Impossible. No adaptive cross-axis sizing; no content-determined container height.' },
    { type: 'blue', text: 'All H-grids are always adaptive — contentDeterminedDimension()=Both → Yoga measures item heights + widths.' },
    { type: 'blue', text: 'Engine tracks global max measured height across ALL sections. Container auto-sizes: max × cols + spacing + insets.' },
    { type: 'blue', text: 'Items have varying content (0–4 description lines). Container height grows as taller items are measured or inserted.' },
  ],
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
    { type: 'blue', text: 'Multi-section: 3 sections with sticky push headers/footers and animated section backgrounds.' },
    { type: 'blue', text: 'Engine: C++ MasonryLayout via JSI. Shortest-column placement, Yoga height refinement.' },
    { type: 'blue', text: 'Tap any cell to resize it (height ×1.5) — downstream items in same and other lanes reflow correctly.' },
  ],
  hmasonry: [
    { type: 'green', text: 'FlashList: Not possible. No horizontal masonry mode.' },
    { type: 'blue', text: 'Horizontal masonry: lanes run left→right, items placed into shortest lane (by accumulated width).' },
    { type: 'blue', text: 'Container height is adaptive — self-determined from Yoga-measured item heights (same as H-grid).' },
    { type: 'blue', text: 'Engine: C++ MasonryLayout horizontal path. shouldInvalidate=false prevents oscillation loop.' },
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
  { key: 'hgrid', label: 'H-Grid' },
  { key: 'ahgrid', label: 'AH-Grid' },
  { key: 'masonry', label: 'Masonry' },
  { key: 'hmasonry', label: 'H-Masonry' },
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
        {subTab === 'hgrid' && <HorizontalGridDemo />}
        {subTab === 'ahgrid' && <AdaptiveHGridDemo />}
        {subTab === 'masonry' && <MasonryDemo />}
        {subTab === 'hmasonry' && <HMasonryDemo />}
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

  gridCell: { height: 100, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  gridCellText: { fontSize: 18, fontWeight: '700' },

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

const H_RESIZE_DESC = 'Resized — wider card.\nExtra line 2.\nExtra line 3.';

// Section metadata for headers/footers
const H_SECTIONS_META: { key: string; label: string; icon: string; color: string }[] = [
  { key: 'nature',   label: 'Nature',   icon: '🌿', color: '#0f2a1a' },
  { key: 'cities',   label: 'Cities',   icon: '🏙', color: '#0a1a2a' },
  { key: 'abstract', label: 'Abstract', icon: '🎨', color: '#1a0a2a' },
];

export function HorizontalListDemo() {
  // Section 0 (nature) is mutable — insert / delete / resize act on it
  const staticSections = useMemo(() => makeHSections(), []);
  const [s0Items, setS0Items] = useState<HCard[]>(staticSections[0]!.items);
  const [resizedIds, setResizedIds] = useState<Set<string>>(() => new Set());
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const [decoCount, setDecoCount] = useState(0);
  const insertCounter = useRef(staticSections[0]!.items.length);
  const cvRef = useRef<RiffHandle>(null);

  // ── Mutation handlers ──────────────────────────────────────────────────────

  const handleInsert = useCallback(() => {
    const newItems: HCard[] = Array.from({ length: 3 }, () => {
      const idx = insertCounter.current++;
      return {
        id: `nature-ins-${idx}`,
        color: H_COLORS[idx % H_COLORS.length]!,
        num: idx,
        label: `New ${idx + 1}`,
        description: 'Inserted card — scroll right to see MVC.',
        tags: ['new'],
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

  const resizeFirst = useCallback(() => {
    if (s0Items.length > 0) toggleResize(s0Items[0]!.id);
  }, [s0Items, toggleResize]);

  // ── Sections ───────────────────────────────────────────────────────────────

  const riffSections = useMemo(() => {
    const allSections = [
      { ...staticSections[0]!, items: s0Items },
      staticSections[1]!,
      staticSections[2]!,
    ];
    return allSections.map((s, sIdx) => {
      const meta = H_SECTIONS_META[sIdx]!;
      return {
        key: s.key,
        data: s.items,
        header: {
          render: () => (
            <View style={[HS.sectionHeader, { backgroundColor: meta.color }]}>
              <Text style={HS.sectionHeaderTitle}>
                {meta.label.toUpperCase().split('').join('\n')}
              </Text>
            </View>
          ),
          height: 20,
          sticky: true,
        },
        footer: {
          render: () => (
            <View style={[HS.sectionFooter, { backgroundColor: meta.color }]}>
              <Text style={HS.sectionFooterLabel}>
                {'END'.split('').join('\n')}
              </Text>
            </View>
          ),
          height: 20,
          sticky: true,
        },
        insets: { top: 10, bottom: 10, left: 12, right: 12 },
      };
    });
  }, [s0Items, staticSections]);

  const hLayout = useMemo(() => list({
    horizontal: true,
    itemHeight: 130,
    estimatedCrossAxisHeight: 140,
    itemSpacing: 10,
    sectionSpacing: 4,
    sectionBackground: true,
  }), []);

  // ── Decoration renderers (section backgrounds) ─────────────────────────────

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <AnimatedSectionBg sectionIndex={sectionIndex} frame={frame} />
    ),
  }), []);

  // ── renderItem ─────────────────────────────────────────────────────────────

  const renderCard = useCallback(({ item }: { item: HCard }) => {
    const isResized = resizedIds.has(item.id);
    const description = isResized ? H_RESIZE_DESC : item.description;
    const tags = isResized ? ['resized', 'wider', ...item.tags] : item.tags;
    return (
      <View style={[HS.card, { backgroundColor: item.color + 'cc' }]}>
        <View style={HS.cardThumb}>
          <Text style={HS.cardThumbNum}>{item.num + 1}</Text>
        </View>
        <Text style={HS.cardLabel}>{item.label}</Text>
        {description.length > 0 && (
          <Text style={HS.cardDesc}>{description}</Text>
        )}
        {tags.length > 0 && (
          <View style={HS.tagRow}>
            {tags.map(t => (
              <View key={t} style={HS.tag}>
                <Text style={HS.tagText}>{t}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }, [resizedIds]);

  const keyExtractor = useCallback((item: HCard) => item.id, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#0a0a0a' }}>
      <View style={HS.titleBar}>
        <Text style={HS.title}>Horizontal List</Text>
        <Text style={HS.subtitle}>3 sections · sticky headers/footers · section backgrounds · insert/delete/resize</Text>
      </View>

      {/* Controls bar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={HS.ctrlBar} contentContainerStyle={HS.ctrlBarContent}>
        <CtrlBtn label="← Start" onPress={() => cvRef.current?.scrollToOffset({ x: 0 })} />
        <CtrlBtn label="→ S1" onPress={() => cvRef.current?.scrollToItem('cities:city-0', { position: 'start' })} />
        <CtrlBtn label="→ S2" onPress={() => cvRef.current?.scrollToItem('abstract:abs-0', { position: 'start' })} />
        <CtrlBtn label="→ End" onPress={() => cvRef.current?.scrollToItem('abstract:abs-14', { position: 'end' })} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="+Insert" onPress={handleInsert} />
        <CtrlBtn label="×Delete" onPress={handleDelete} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="↔S0[0]" onPress={resizeFirst} active={s0Items.length > 0 && resizedIds.has(s0Items[0]!.id)} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label={mvcEnabled ? 'MVC: ON' : 'MVC: OFF'} onPress={() => setMvcEnabled(v => !v)} active={mvcEnabled} />
        <View style={{ paddingHorizontal: 6, justifyContent: 'center' }}>
          <Text style={{ color: '#888', fontSize: 10, fontWeight: '600' }}>Deco:{decoCount}</Text>
        </View>
      </ScrollView>

      {/* List background + content-determined height container */}
      <View style={HS.listBackground}>
        <CollectionView
          handle={cvRef}
          sections={riffSections}
          layout={hLayout}
          renderItem={renderCard}
          keyExtractor={keyExtractor}
          estimatedItemHeight={140}
          extraData={resizedIds}
          maintainVisibleContentPosition={mvcEnabled}
          decorationRenderers={decorationRenderers}
          onDecorationCountChange={setDecoCount}
          scrollViewProps={{ style: { backgroundColor: 'transparent' }, indicatorStyle: 'white' }}
        />
      </View>
    </View>
  );
}

const HS = StyleSheet.create({
  titleBar:           { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  title:              { fontSize: 15, fontWeight: '700', color: '#e2e8f0' },
  subtitle:           { fontSize: 11, color: '#475569', marginTop: 2 },

  ctrlBar:            { backgroundColor: '#111', flexGrow: 0 },
  ctrlBarContent:     { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 7, alignItems: 'center' },

  listBackground:     { height: 260, backgroundColor: '#0f1623', marginHorizontal: 0,
                        borderRadius: 0, overflow: 'hidden' },

  // Section header — full cross-axis height via flex:1, narrow 20px primary-axis strip
  sectionHeader:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionHeaderTitle: { fontSize: 8, fontWeight: '700', color: 'rgba(255,255,255,0.7)',
                        textAlign: 'center', lineHeight: 10 },

  // Section footer — same narrow strip
  sectionFooter:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionFooterLabel: { fontSize: 8, color: 'rgba(255,255,255,0.5)', fontWeight: '600',
                        textAlign: 'center', lineHeight: 10 },

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

// ─────────────────────────────────────────────────────────────────────────────
// HorizontalGridDemo
// 2-row horizontal grid (columns=2) with 3 sections, sticky headers/footers,
// section backgrounds, row/column-group separators, insert/delete, MVC toggle.
// ─────────────────────────────────────────────────────────────────────────────

const HG_SECTIONS_META = H_SECTIONS_META; // reuse same metadata

const makeHGSections = () => [
  {
    key: 'hg-nature',
    items: Array.from({ length: 14 }, (_, i) => ({
      id: `hg-nature-${i}`,
      color: H_COLORS[i % H_COLORS.length]!,
      num: i,
      label: `Nature ${i + 1}`,
      tags: HG_TAG_POOLS[i % HG_TAG_POOLS.length]!,
    })),
  },
  {
    key: 'hg-cities',
    items: Array.from({ length: 10 }, (_, i) => ({
      id: `hg-city-${i}`,
      color: H_COLORS[(i + 3) % H_COLORS.length]!,
      num: i,
      label: `City ${i + 1}`,
      tags: HG_TAG_POOLS[(i + 2) % HG_TAG_POOLS.length]!,
    })),
  },
  {
    key: 'hg-abstract',
    items: Array.from({ length: 12 }, (_, i) => ({
      id: `hg-abs-${i}`,
      color: H_COLORS[(i + 6) % H_COLORS.length]!,
      num: i,
      label: `Art ${i + 1}`,
      tags: HG_TAG_POOLS[(i + 1) % HG_TAG_POOLS.length]!,
    })),
  },
];

type HGCard = { id: string; color: string; num: number; label: string; tags: string[] };

// Cross-axis layout constants — shared between layout params and container sizing.
// containerH = itemCrossH * cols + columnSpacing*(cols-1) + insetTop + insetBottom
const HG_COLS         = 2;
const HG_COL_SPACING  = 8;
const HG_INSET_Y      = 8;     // top and bottom each
const HG_ITEM_CROSS_H = 120;   // desired per-item cross-axis height
const HG_CONTAINER_H  = HG_ITEM_CROSS_H * HG_COLS + HG_COL_SPACING * (HG_COLS - 1) + HG_INSET_Y * 2;
// = 120*2 + 8 + 16 = 264

const HG_TAG_POOLS: string[][] = [[], ['new'], ['sale', 'hot'], ['featured']];

export function HorizontalGridDemo() {
  const staticSections = useMemo(() => makeHGSections(), []);
  const [s0Items, setS0Items] = useState<HGCard[]>(staticSections[0]!.items);
  const [resizedIds, setResizedIds] = useState<Set<string>>(() => new Set());
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const [sepEnabled, setSepEnabled] = useState(false);
  const [decoCount, setDecoCount] = useState(0);
  const [containerH, setContainerH] = useState(HG_CONTAINER_H);
  const insertCounter = useRef(staticSections[0]!.items.length);
  const cvRef = useRef<RiffHandle>(null);

  const handleInsert1 = useCallback(() => {
    const idx = insertCounter.current++;
    const item: HGCard = {
      id: `hg-nature-ins-${idx}`,
      color: H_COLORS[idx % H_COLORS.length]!,
      num: idx,
      label: `New ${idx + 1}`,
      tags: ['new'],
    };
    setS0Items(prev => [item, ...prev]);
  }, []);

  const handleInsert4 = useCallback(() => {
    const newItems: HGCard[] = Array.from({ length: 4 }, () => {
      const idx = insertCounter.current++;
      return {
        id: `hg-nature-ins-${idx}`,
        color: H_COLORS[idx % H_COLORS.length]!,
        num: idx,
        label: `New ${idx + 1}`,
        tags: ['new'],
      };
    });
    setS0Items(prev => [...newItems, ...prev]);
  }, []);

  const handleDelete = useCallback(() => {
    setS0Items(prev => prev.length >= 4 ? prev.slice(4) : prev);
  }, []);

  const toggleResize = useCallback((id: string) => {
    setResizedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const resizeFirst = useCallback(() => {
    if (s0Items.length > 0) toggleResize(s0Items[0]!.id);
  }, [s0Items, toggleResize]);

  const riffSections = useMemo(() => {
    const allSections = [
      { ...staticSections[0]!, items: s0Items },
      staticSections[1]!,
      staticSections[2]!,
    ];
    return allSections.map((sec, sIdx) => {
      const meta = HG_SECTIONS_META[sIdx]!;
      return {
        key: sec.key,
        data: sec.items,
        header: {
          render: () => (
            <View style={[HGS.sectionHeader, { backgroundColor: meta.color }]}>
              <Text style={HGS.sectionHeaderTitle}>
                {meta.label.toUpperCase().split('').join('\n')}
              </Text>
            </View>
          ),
          height: 20,
          sticky: true,
        },
        footer: {
          render: () => (
            <View style={[HGS.sectionFooter, { backgroundColor: meta.color }]}>
              <Text style={HGS.sectionFooterLabel}>{'END'.split('').join('\n')}</Text>
            </View>
          ),
          height: 20,
          sticky: true,
        },
        insets: { top: HG_INSET_Y, bottom: HG_INSET_Y, left: 10, right: 10 },
      };
    });
  }, [s0Items, staticSections]);

  const hgLayout = useMemo(() => grid({
    horizontal: true,
    columns: HG_COLS,
    rowHeight: 110,           // estimated item width (primary axis); Yoga measures actual
    estimatedCrossAxisHeight: 110,
    columnSpacing: HG_COL_SPACING,
    rowSpacing: 4,
    sectionSpacing: 8,
    sectionBackground: true,
    ...(sepEnabled ? { separator: { height: 1.5 } } : {}),
  }), [sepEnabled]);

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <AnimatedSectionBg sectionIndex={sectionIndex} frame={frame} />
    ),
  }), []);

  const renderCard = useCallback(({ item }: { item: HGCard }) => {
    const isResized = resizedIds.has(item.id);
    const tags = isResized ? ['resized', 'wider', ...item.tags] : item.tags;
    return (
      <View style={[HGS.card, { backgroundColor: item.color + 'cc' }]}>
        <View style={HGS.cardThumb}>
          <Text style={HGS.cardThumbNum}>{item.num + 1}</Text>
        </View>
        <Text style={HGS.cardLabel}>{isResized ? `${item.label} — wider content` : item.label}</Text>
        {tags.length > 0 && (
          <View style={HGS.tagRow}>
            {tags.map(t => (
              <View key={t} style={HGS.tag}>
                <Text style={HGS.tagText}>{t}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }, [resizedIds]);

  const keyExtractor = useCallback((item: HGCard) => item.id, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#0a0a0a' }}>
      <View style={HGS.titleBar}>
        <Text style={HGS.title}>Horizontal Grid (2 rows · adaptive cross-axis)</Text>
        <Text style={HGS.subtitle}>Container height auto-sizes from content — currently {Math.round(containerH)}pt</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={HGS.ctrlBar} contentContainerStyle={HGS.ctrlBarContent}>
        <CtrlBtn label="← Start" onPress={() => cvRef.current?.scrollToOffset({ x: 0 })} />
        <CtrlBtn label="→ S1" onPress={() => cvRef.current?.scrollToItem('hg-cities:hg-city-0', { position: 'start' })} />
        <CtrlBtn label="→ S2" onPress={() => cvRef.current?.scrollToItem('hg-abstract:hg-abs-0', { position: 'start' })} />
        <CtrlBtn label="→ End" onPress={() => cvRef.current?.scrollToItem('hg-abstract:hg-abs-11', { position: 'end' })} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="+1" onPress={handleInsert1} />
        <CtrlBtn label="+4" onPress={handleInsert4} />
        <CtrlBtn label="×4" onPress={handleDelete} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="↔S0[0]" onPress={resizeFirst} active={s0Items.length > 0 && resizedIds.has(s0Items[0]!.id)} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label={sepEnabled ? 'Sep: ON' : 'Sep: OFF'} onPress={() => setSepEnabled(v => !v)} active={sepEnabled} />
        <CtrlBtn label={mvcEnabled ? 'MVC: ON' : 'MVC: OFF'} onPress={() => setMvcEnabled(v => !v)} active={mvcEnabled} />
        <View style={{ paddingHorizontal: 6, justifyContent: 'center' }}>
          <Text style={{ color: '#888', fontSize: 10, fontWeight: '600' }}>Deco:{decoCount}</Text>
        </View>
      </ScrollView>

      <View style={[HGS.listBackground, { height: containerH }]}>
        <CollectionView
          handle={cvRef}
          sections={riffSections}
          layout={hgLayout}
          renderItem={renderCard}
          keyExtractor={keyExtractor}
          estimatedItemHeight={HG_ITEM_CROSS_H}
          extraData={resizedIds}
          maintainVisibleContentPosition={mvcEnabled}
          decorationRenderers={decorationRenderers}
          onDecorationCountChange={setDecoCount}
          scrollViewProps={{
            style: { backgroundColor: 'transparent' },
            indicatorStyle: 'white',
            onContentSizeChange: (_w: number, h: number) => {
              if (h > 0) setContainerH(prev => Math.abs(prev - h) > 2 ? h : prev);
            },
          }}
        />
      </View>
    </View>
  );
}

const HGS = StyleSheet.create({
  titleBar:           { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  title:              { fontSize: 15, fontWeight: '700', color: '#e2e8f0' },
  subtitle:           { fontSize: 11, color: '#475569', marginTop: 2 },

  ctrlBar:            { backgroundColor: '#111', flexGrow: 0 },
  ctrlBarContent:     { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 7, alignItems: 'center' },

  listBackground:     { backgroundColor: '#0f1623', overflow: 'hidden' },

  sectionHeader:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionHeaderTitle: { fontSize: 8, fontWeight: '700', color: 'rgba(255,255,255,0.7)',
                        textAlign: 'center', lineHeight: 10 },

  sectionFooter:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionFooterLabel: { fontSize: 8, color: 'rgba(255,255,255,0.5)', fontWeight: '600',
                        textAlign: 'center', lineHeight: 10 },

  card:               { borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                        paddingVertical: 10, paddingHorizontal: 6, margin: 4 },
  cardThumb:          { width: 56, height: 56, borderRadius: 10,
                        backgroundColor: 'rgba(0,0,0,0.3)',
                        alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  cardThumbNum:       { fontSize: 22, fontWeight: '800', color: '#fff' },
  cardLabel:          { fontSize: 10, color: 'rgba(255,255,255,0.85)', fontWeight: '600',
                        textAlign: 'center' },
  tagRow:             { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: 6,
                        justifyContent: 'center' },
  tag:                { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 4,
                        paddingHorizontal: 5, paddingVertical: 2 },
  tagText:            { fontSize: 8, color: '#fff', fontWeight: '700', textTransform: 'uppercase' },
});

// ─────────────────────────────────────────────────────────────────────────────
// AdaptiveHGridDemo
// ─────────────────────────────────────────────────────────────────────────────
// Horizontal grid — all H-grids are always adaptive. Items have varying content
// heights (0–4 description lines, giving ~50px of variance). The container
// height auto-sizes to maxItemHeight × cols + spacing + insets.
// No fixed container height — uses layout contentSize() after first pass.
// ─────────────────────────────────────────────────────────────────────────────

const AHG_COLS        = 2;
const AHG_COL_SPACING = 8;
const AHG_INSET_Y     = 10;
const AHG_ESTIMATED_H = 150; // initial estimate before Yoga measures items

const AHG_DESCRIPTIONS = [
  '',                                                        // no description
  'Short note.',                                             // 1 line
  'A medium-length description\nthat wraps to two lines.',   // 2 lines
  'Longer description with more\ndetail across three lines\nof text content here.',  // 3 lines
  'Extended description with four\nlines of varying content\nthat pushes the item\ntaller than the rest.', // 4 lines
];

const AHG_COLORS = [
  '#1a3a5c', '#2d5a27', '#5c1a2e', '#3a2d5c',
  '#5c3a1a', '#1a5c4f', '#4a1a5c', '#5c4a1a',
];

type AHGCard = { id: string; color: string; num: number; label: string; desc: string; tags: string[] };

function makeAHGSections(): { key: string; items: AHGCard[] }[] {
  const TAGS = [[], ['new'], ['hot'], ['sale', 'new'], ['featured']];
  const sections = [
    { key: 'ahg-nature',   count: 12, prefix: 'ahg-nat' },
    { key: 'ahg-cities',   count: 10, prefix: 'ahg-city' },
    { key: 'ahg-abstract', count: 14, prefix: 'ahg-abs' },
  ];
  return sections.map(sec => ({
    key: sec.key,
    items: Array.from({ length: sec.count }, (_, i) => ({
      id:    `${sec.prefix}-${i}`,
      color: AHG_COLORS[(i + sec.count) % AHG_COLORS.length]!,
      num:   i,
      label: `${sec.key.split('-')[1]} #${i + 1}`,
      desc:  AHG_DESCRIPTIONS[i % AHG_DESCRIPTIONS.length]!,
      tags:  TAGS[i % TAGS.length]!,
    })),
  }));
}

const staticAHGSections = makeAHGSections();

function AdaptiveHGridDemo() {
  const cvRef = useRef<any>(null);
  const layoutRef = useRef(
    grid({
      horizontal: true,
      columns: AHG_COLS,
      estimatedCrossAxisHeight: 120,
      columnSpacing: AHG_COL_SPACING,
      rowSpacing: 4,
      sectionSpacing: 8,
      sectionBackground: true,
      stickyMode: 'push',
      headerHeight: 20,
      footerHeight: 20,
      sectionBackgroundContentInsets: { top: -2, bottom: -2, left: -4, right: -4 },
    })
  );

  const [s0Items, setS0Items] = useState<AHGCard[]>(staticAHGSections[0]!.items);
  const [s1Items] = useState<AHGCard[]>(staticAHGSections[1]!.items);
  const [s2Items] = useState<AHGCard[]>(staticAHGSections[2]!.items);
  const [containerH, setContainerH] = useState(AHG_ESTIMATED_H);
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const [decoCount, setDecoCount] = useState(0);

  // Counter for unique inserted item IDs
  const insertCounter = useRef(100);

  const handleInsert = useCallback(() => {
    const n = insertCounter.current++;
    // Pick a random description to add height variance
    const desc = AHG_DESCRIPTIONS[n % AHG_DESCRIPTIONS.length]!;
    const newItem: AHGCard = {
      id:    `ahg-ins-${n}`,
      color: AHG_COLORS[n % AHG_COLORS.length]!,
      num:   n,
      label: `Inserted #${n}`,
      desc,
      tags:  n % 3 === 0 ? ['new'] : [],
    };
    setS0Items(prev => [newItem, ...prev]);
  }, []);

  const handleDelete = useCallback(() => {
    setS0Items(prev => (prev.length > 1 ? prev.slice(0, -4) : prev));
  }, []);

  const sections = useMemo(() => [
    { key: 'ahg-nature',   data: s0Items },
    { key: 'ahg-cities',   data: s1Items },
    { key: 'ahg-abstract', data: s2Items },
  ], [s0Items, s1Items, s2Items]);

  const META: Record<string, { color: string; label: string }> = {
    'ahg-nature':   { color: '#14532d', label: 'NATURE' },
    'ahg-cities':   { color: '#1e3a5f', label: 'CITIES' },
    'ahg-abstract': { color: '#4a1942', label: 'ABS' },
  };

  const renderHeader = useCallback(({ section }: { section: any }) => {
    const meta = META[section.key] ?? { color: '#333', label: section.key };
    return (
      <View style={[AHGS.sectionHeader, { backgroundColor: meta.color }]}>
        <Text style={AHGS.sectionHeaderTitle}>{meta.label.split('').join('\n')}</Text>
      </View>
    );
  }, []);

  const renderFooter = useCallback(({ section }: { section: any }) => {
    const meta = META[section.key] ?? { color: '#333', label: section.key };
    return (
      <View style={[AHGS.sectionFooter, { backgroundColor: meta.color }]}>
        <Text style={AHGS.sectionFooterLabel}>{'END'.split('').join('\n')}</Text>
      </View>
    );
  }, []);

  const renderCard = useCallback(({ item }: { item: AHGCard }) => (
    <View style={[AHGS.card, { backgroundColor: item.color + 'cc' }]}>
      <View style={AHGS.cardThumb}>
        <Text style={AHGS.cardThumbNum}>{item.num + 1}</Text>
      </View>
      <Text style={AHGS.cardLabel}>{item.label}</Text>
      {item.desc !== '' && (
        <Text style={AHGS.cardDesc}>{item.desc}</Text>
      )}
      {item.tags.length > 0 && (
        <View style={AHGS.tagRow}>
          {item.tags.map(t => (
            <View key={t} style={AHGS.tag}>
              <Text style={AHGS.tagText}>{t}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  ), []);

  const keyExtractor = useCallback((item: AHGCard) => item.id, []);

  const onContentSizeChange = useCallback((_w: number, h: number) => {
    if (h > 20) setContainerH(prev => Math.abs(prev - h) > 2 ? h : prev);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#0a0a0a' }}>
      <View style={AHGS.titleBar}>
        <Text style={AHGS.title}>Adaptive H-Grid (2 rows · auto cross-axis)</Text>
        <Text style={AHGS.subtitle}>
          {'Container = maxItemHeight × 2 + spacing + insets · now: ' + Math.round(containerH) + 'pt'}
        </Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={AHGS.ctrlBar} contentContainerStyle={AHGS.ctrlBarContent}>
        <CtrlBtn label="← Start" onPress={() => cvRef.current?.scrollToOffset({ x: 0 })} />
        <CtrlBtn label="→ S1" onPress={() => cvRef.current?.scrollToItem('ahg-cities:ahg-city-0', { position: 'start' })} />
        <CtrlBtn label="→ S2" onPress={() => cvRef.current?.scrollToItem('ahg-abstract:ahg-abs-0', { position: 'start' })} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label="+1" onPress={handleInsert} />
        <CtrlBtn label="×4" onPress={handleDelete} />
        <View style={S.ctrlDivider} />
        <CtrlBtn label={mvcEnabled ? 'MVC: ON' : 'MVC: OFF'} onPress={() => setMvcEnabled(v => !v)} active={mvcEnabled} />
        <View style={{ paddingHorizontal: 6, justifyContent: 'center' }}>
          <Text style={{ color: '#888', fontSize: 10, fontWeight: '600' }}>Deco:{decoCount}</Text>
        </View>
      </ScrollView>

      {/* Container auto-sized from contentSize reported after first layout pass */}
      <View style={[AHGS.listBackground, { height: containerH }]}>
        <CollectionView
          ref={cvRef}
          horizontal
          sections={sections}
          layout={layoutRef.current}
          keyExtractor={keyExtractor}
          renderItem={renderCard}
          renderSectionHeader={renderHeader}
          renderSectionFooter={renderFooter}
          decorationRenderers={{
            sectionBackground: {
              render: (si, frame) => (
                <View style={{
                  ...StyleSheet.absoluteFillObject,
                  backgroundColor: Object.values(META)[si % 3]?.color + '33',
                  borderRadius: 8,
                }} />
              ),
              onCountChange: setDecoCount,
            },
          }}
          stickyHeaderIndices={[]}
          scrollEventThrottle={16}
          mutationVector={mvcEnabled ? { type: 'auto' } : undefined}
          scrollViewProps={{ onContentSizeChange }}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

const AHGS = StyleSheet.create({
  titleBar:  { paddingHorizontal: 12, paddingVertical: 6 },
  title:     { fontSize: 12, fontWeight: '700', color: '#ccc' },
  subtitle:  { fontSize: 10, color: '#666', marginTop: 2 },

  ctrlBar:        { flexGrow: 0, backgroundColor: '#111' },
  ctrlBarContent: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6, gap: 4 },

  listBackground: { backgroundColor: '#0f1623', overflow: 'hidden' },

  sectionHeader:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionHeaderTitle: { fontSize: 7, fontWeight: '700', color: 'rgba(255,255,255,0.7)',
                        textAlign: 'center', lineHeight: 9 },
  sectionFooter:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionFooterLabel: { fontSize: 7, color: 'rgba(255,255,255,0.5)', fontWeight: '600',
                        textAlign: 'center', lineHeight: 9 },

  // Card: NOT flex:1 here — let content determine natural height for adaptive measurement.
  card:        { borderRadius: 12, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6,
                 margin: 4 },
  cardThumb:   { width: 48, height: 48, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.3)',
                 alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  cardThumbNum:{ fontSize: 18, fontWeight: '800', color: '#fff' },
  cardLabel:   { fontSize: 10, color: 'rgba(255,255,255,0.9)', fontWeight: '600',
                 textAlign: 'center' },
  cardDesc:    { fontSize: 9, color: 'rgba(255,255,255,0.55)', textAlign: 'center',
                 marginTop: 4, lineHeight: 13 },
  tagRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: 5,
                 justifyContent: 'center' },
  tag:         { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 4,
                 paddingHorizontal: 4, paddingVertical: 2 },
  tagText:     { fontSize: 7, color: '#fff', fontWeight: '700', textTransform: 'uppercase' },
});
