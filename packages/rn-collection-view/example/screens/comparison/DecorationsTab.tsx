/**
 * Tab 3 — Section Decorations with Animated Backgrounds
 *
 * 5 sections with distinct animated shimmer backgrounds.
 * The decoration is a real React component — animation runs continuously.
 *
 * CollectionView: renderSectionBackground — first-class API.
 * FlashList: No decoration concept. Shows plain list for comparison.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff, type SectionConfig } from '../../components/CollectionView';

// ── Data ──────────────────────────────────────────────────────────────────────

const SECTION_COUNT = 5;
const ITEMS_PER_SECTION = 15;

const GRADIENTS: [string, string][] = [
  ['#1a0a2e', '#3d1a78'],  // purple
  ['#0a1628', '#1a3a5c'],  // blue
  ['#1a2e0a', '#2e5c1a'],  // green
  ['#2e1a0a', '#5c3a1a'],  // amber
  ['#2e0a1a', '#5c1a3a'],  // rose
];

type Item = { id: string; label: string };

function makeSections(): SectionConfig<Item>[] {
  return Array.from({ length: SECTION_COUNT }, (_, s) => ({
    key: `section-${s}`,
    data: Array.from({ length: ITEMS_PER_SECTION }, (_, i) => ({
      id: `${s}-${i}`,
      label: `Section ${s} · Item ${i}`,
    })),
    header: {
      render: () => (
        <View style={S.sectionHeader}>
          <Text style={S.sectionHeaderText}>Section {s}</Text>
        </View>
      ),
      height: 36,
      sticky: true,
    },
  }));
}

// ── Animated section background ───────────────────────────────────────────────

function AnimatedBackground({ sectionIndex }: { sectionIndex: number }) {
  const [bgColor] = GRADIENTS[sectionIndex % GRADIENTS.length]!;
  const shimmerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, { toValue: 1, duration: 2000, useNativeDriver: true }),
        Animated.timing(shimmerAnim, { toValue: 0, duration: 2000, useNativeDriver: true }),
      ]),
    ).start();
  }, [shimmerAnim]);

  const shimmerTranslate = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-300, 300],
  });

  const shimmerOpacity = shimmerAnim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.3, 0.6, 0.3],
  });

  return (
    <View style={[S.bg, { backgroundColor: bgColor }]}>
      <Animated.View
        style={[
          S.shimmerWave,
          {
            opacity: shimmerOpacity,
            transform: [{ translateX: shimmerTranslate }, { skewX: '-20deg' }],
          },
        ]}
      />
    </View>
  );
}

// ── CollectionView with decorations ───────────────────────────────────────────

function CVDecorations() {
  const sections = React.useMemo(() => makeSections(), []);

  return (
    <Riff
      sections={sections}
      renderItem={({ item }) => <DecoCell item={item as Item} transparent />}
      estimatedItemHeight={48}
      renderSectionBackground={(sectionIndex: number) => (
        <AnimatedBackground sectionIndex={sectionIndex} />
      )}
    />
  );
}

// ── FlashList (no decorations) ────────────────────────────────────────────────

type FlatItem = { id: string; label: string; isHeader: boolean; sectionIndex: number };

function FlashDecorations() {
  const data = React.useMemo(() => {
    const flat: FlatItem[] = [];
    for (let s = 0; s < SECTION_COUNT; s++) {
      flat.push({ id: `header-${s}`, label: `Section ${s}`, isHeader: true, sectionIndex: s });
      for (let i = 0; i < ITEMS_PER_SECTION; i++) {
        flat.push({ id: `${s}-${i}`, label: `Section ${s} · Item ${i}`, isHeader: false, sectionIndex: s });
      }
    }
    return flat;
  }, []);

  return (
    <FlashList
      data={data}
      keyExtractor={item => item.id}
      estimatedItemSize={48}
      renderItem={({ item }) =>
        item.isHeader
          ? <View style={S.sectionHeader}><Text style={S.sectionHeaderText}>{item.label}</Text></View>
          : <DecoCell item={item} transparent={false} />
      }
    />
  );
}

function DecoCell({ item, transparent }: { item: { label: string }; transparent: boolean }) {
  return (
    <View style={[S.cell, transparent && S.cellTransparent]}>
      <Text style={S.cellText}>{item.label}</Text>
    </View>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export default function DecorationsTab({ mode }: { mode: 'cv' | 'flash' }) {
  return (
    <View style={S.root}>
      <Text style={S.hint}>
        {mode === 'cv'
          ? 'Animated shimmer backgrounds behind each section · renderSectionBackground API'
          : 'No decoration support · plain list, no section backgrounds'}
      </Text>
      {mode === 'cv' ? <CVDecorations /> : <FlashDecorations />}
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  hint: { fontSize: 11, color: '#4a5568', paddingHorizontal: 12, paddingVertical: 6 },
  bg: { ...StyleSheet.absoluteFillObject, overflow: 'hidden', borderRadius: 12, margin: 4 },
  shimmerWave: { position: 'absolute', top: 0, left: 0, width: 150, height: '100%',
                 backgroundColor: 'rgba(255,255,255,0.15)' },
  sectionHeader: { height: 36, justifyContent: 'center', paddingHorizontal: 16,
                   backgroundColor: 'rgba(0,0,0,0.55)' },
  sectionHeaderText: { fontSize: 13, fontWeight: '700', color: '#fff', letterSpacing: 0.5 },
  cell: { height: 48, justifyContent: 'center', paddingHorizontal: 16,
          borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#333',
          backgroundColor: '#111' },
  cellTransparent: { backgroundColor: 'rgba(0,0,0,0.3)' },
  cellText: { fontSize: 13, color: '#ccc' },
});
