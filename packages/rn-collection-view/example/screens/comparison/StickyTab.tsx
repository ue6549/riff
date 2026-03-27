/**
 * Tab 2 — Sticky Headers: Push + Animation Continuity
 *
 * Each sticky header has:
 *   - A ms ticker updating every 16ms
 *   - A shimmer animation (looping gradient)
 *
 * CollectionView: RNScrollCoordinatedView on UI thread — push + animation continuity.
 * FlashList: stickyHeaderIndices — headers overlap, animation resets on section change.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff, type SectionConfig } from '../../components/CollectionView';

// ── Sections ──────────────────────────────────────────────────────────────────

const SECTION_COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#264653', '#6a4c93', '#1982c4'];
const ITEMS_PER_SECTION = 20;
const SECTION_COUNT = 6;

type Item = { id: string; label: string };

function makeSections(): SectionConfig<Item>[] {
  return Array.from({ length: SECTION_COUNT }, (_, s) => ({
    key: `section-${s}`,
    data: Array.from({ length: ITEMS_PER_SECTION }, (_, i) => ({
      id: `${s}-${i}`,
      label: `Section ${s} · Item ${i}`,
    })),
    header: {
      render: () => <StickyHeader sectionIndex={s} />,
      height: 52,
      sticky: true,
    },
  }));
}

// ── Sticky header with ms ticker + shimmer ────────────────────────────────────

function StickyHeader({ sectionIndex }: { sectionIndex: number }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  const rafRef = useRef<number>();

  // Ms ticker — updates via RAF for smooth counting
  useEffect(() => {
    startRef.current = Date.now();
    const tick = () => {
      setElapsed(Date.now() - startRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Shimmer animation
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 1500,
        useNativeDriver: true,
      }),
    ).start();
  }, [shimmerAnim]);

  const shimmerTranslate = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-200, 200],
  });

  const color = SECTION_COLORS[sectionIndex % SECTION_COLORS.length]!;

  return (
    <View style={[S.stickyHeader, { backgroundColor: color }]}>
      <Animated.View
        style={[S.shimmerBar, { transform: [{ translateX: shimmerTranslate }] }]}
      />
      <Text style={S.stickyTitle}>Section {sectionIndex}</Text>
      <Text style={S.stickyTimer}>{elapsed}ms</Text>
    </View>
  );
}

// ── FlashList flat data with sticky indices ───────────────────────────────────

type FlatItem = { id: string; label: string; isHeader: boolean; sectionIndex: number };

function makeFlatData(): { data: FlatItem[]; stickyIndices: number[] } {
  const data: FlatItem[] = [];
  const stickyIndices: number[] = [];
  for (let s = 0; s < SECTION_COUNT; s++) {
    stickyIndices.push(data.length);
    data.push({ id: `header-${s}`, label: `Section ${s}`, isHeader: true, sectionIndex: s });
    for (let i = 0; i < ITEMS_PER_SECTION; i++) {
      data.push({ id: `${s}-${i}`, label: `Section ${s} · Item ${i}`, isHeader: false, sectionIndex: s });
    }
  }
  return { data, stickyIndices };
}

// ── CollectionView implementation ─────────────────────────────────────────────

function CVSticky() {
  const sections = React.useMemo(() => makeSections(), []);
  return (
    <Riff
      sections={sections}
      renderItem={({ item }) => <ItemCell item={item as Item} />}
      estimatedItemHeight={44}
      stickyMode="push"
    />
  );
}

// ── FlashList implementation ──────────────────────────────────────────────────

function FlashSticky() {
  const { data, stickyIndices } = React.useMemo(() => makeFlatData(), []);
  return (
    <FlashList
      data={data}
      keyExtractor={item => item.id}
      stickyHeaderIndices={stickyIndices}
      estimatedItemSize={44}
      renderItem={({ item }) =>
        item.isHeader
          ? <StickyHeader sectionIndex={item.sectionIndex} />
          : <ItemCell item={item} />
      }
    />
  );
}

function ItemCell({ item }: { item: { label: string } }) {
  return (
    <View style={S.itemCell}>
      <Text style={S.itemText}>{item.label}</Text>
    </View>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export default function StickyTab({ mode }: { mode: 'cv' | 'flash' }) {
  return (
    <View style={S.root}>
      <Text style={S.hint}>
        {mode === 'cv'
          ? 'Push behavior · ms ticker never resets · shimmer continuous'
          : 'Headers overlap · ms ticker resets on section change'}
      </Text>
      {mode === 'cv' ? <CVSticky /> : <FlashSticky />}
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  hint: { fontSize: 11, color: '#4a5568', paddingHorizontal: 12, paddingVertical: 6 },
  stickyHeader: { height: 52, flexDirection: 'row', alignItems: 'center',
                  justifyContent: 'space-between', paddingHorizontal: 16,
                  overflow: 'hidden' },
  shimmerBar: { position: 'absolute', top: 0, left: 0, width: 100, height: '100%',
                backgroundColor: 'rgba(255,255,255,0.15)', transform: [{ skewX: '-20deg' }] },
  stickyTitle: { fontSize: 15, fontWeight: '700', color: '#fff', zIndex: 1 },
  stickyTimer: { fontSize: 12, fontFamily: 'Menlo', color: 'rgba(255,255,255,0.8)', zIndex: 1 },
  itemCell: { height: 44, justifyContent: 'center', paddingHorizontal: 16,
              borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  itemText: { fontSize: 13, color: '#ccc' },
});
