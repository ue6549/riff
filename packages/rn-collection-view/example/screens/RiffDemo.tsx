/**
 * Riff Demo — standalone showcase of all layout types.
 *
 * Each tab demos a specific layout engine with vertical variants,
 * decorations, mutations, and sticky headers where applicable.
 *
 * Tabs come in three families:
 *   - Built-in layouts: list / grid / masonry / flow (vertical + horizontal variants).
 *   - Legacy custom layouts (pre-H-2): `circular`, `carousel` — built on a plain
 *     ScrollView with JS-side style updates per scroll tick.
 *   - H-2 framework demos: `h2-radial`, `h2-carousel3d`, `h2-spiral`, `h2-hex` —
 *     each uses the generic `CollectionSubContainer` + a layout from
 *     `src/layouts/`. Frames + opacity + zIndex + CATransform3D are applied
 *     natively by `CollectionSubContainerShadowNode` → `RNCollectionSubContainerView`,
 *     with one JSI batch (`setAttributesBatch`) per scroll tick — no per-cell JSI,
 *     no React re-render of cells, no Yoga reflow.
 *
 * Resize button: animates container to 60% width to show responsive
 * column reflow for grid (3→2→1) and masonry (2→1).
 */
import React, { useState, useRef } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ListDemo, HorizontalListDemo, GridDemo, HorizontalGridDemo, MasonryDemo, FlowDemo } from './comparison/LayoutsTab';
import { CircularList } from '../components/CircularList';
import { Carousel3D } from '../components/Carousel3D';
import { CompositionalDemo } from './CompositionalDemo';
import { CompositionalLab } from './CompositionalLab';
import { CollectionSubContainer } from '@riff/components/CollectionSubContainer';
import { radial } from '@riff/layouts/radial';
import { carousel3D as carousel3DLayout } from '@riff/layouts/carousel3D';
import { spiral } from '@riff/layouts/spiral';
import { hex } from '@riff/layouts/hex';

type DemoTab = 'list-v' | 'list-h' | 'grid-v' | 'grid-h' | 'masonry-v' | 'flow-v' | 'circular' | 'carousel' | 'compose' | 'lab'
  | 'h2-radial' | 'h2-carousel3d' | 'h2-spiral' | 'h2-hex';

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];
const CIRCULAR_DATA = Array.from({ length: 12 }, (_, i) => ({ id: i, label: `${i}`, color: COLORS[i % COLORS.length]! }));
const CAROUSEL_DATA = Array.from({ length: 8 }, (_, i) => ({ id: i, title: `Card ${i}`, color: COLORS[i % COLORS.length]! }));

// H-2 demo data sets — small to keep the showcase punchy.
const RADIAL_DATA    = Array.from({ length: 16 }, (_, i) => ({ id: i, label: `${i + 1}`, color: COLORS[i % COLORS.length]! }));
const CAROUSEL3D_DATA = Array.from({ length: 12 }, (_, i) => ({ id: i, title: `Cover ${i + 1}`, color: COLORS[i % COLORS.length]! }));
const SPIRAL_DATA    = Array.from({ length: 24 }, (_, i) => ({ id: i, label: `${i + 1}`, color: COLORS[i % COLORS.length]! }));
const HEX_DATA       = Array.from({ length: 28 }, (_, i) => ({ id: i, label: `${i + 1}`, color: COLORS[i % COLORS.length]! }));

const TABS: { key: DemoTab; label: string; detail: string }[] = [
  { key: 'list-v',    label: 'List ↕',    detail: 'Vertical · sections · decorations · mutations · sticky' },
  { key: 'list-h',    label: 'List ↔',    detail: 'Horizontal · sections · fixed-width cards' },
  { key: 'grid-v',    label: 'Grid ↕',    detail: 'Grid · responsive columns (3→2→1) · sticky · section bkg · mutations · MVC' },
  { key: 'grid-h',    label: 'Grid ↔',    detail: 'Horizontal grid · columns=2 · section backgrounds · insert/delete · MVC' },
  { key: 'masonry-v', label: 'Masonry ↕', detail: 'Masonry · responsive columns (2→1) · sticky · section bkg · mutations · MVC' },
  { key: 'flow-v',    label: 'Flow ↕',    detail: 'Flow · product cards + tags · two-pass · sticky · section bkg · mutations · MVC' },
  { key: 'circular',  label: 'Radial',    detail: 'Radial arc · legacy ScrollView · pre-H-2 implementation' },
  { key: 'carousel',  label: '3D Carousel', detail: 'Cover-flow · legacy ScrollView · pre-H-2 implementation' },
  { key: 'compose',   label: 'Compose ↕',  detail: 'Compositional · list + grid + flow + masonry · one scroll · shared recycling pool' },
  { key: 'lab',       label: 'Lab',         detail: 'Test bench · all 7 layout types · per-section mutations · insert/delete/resize/update' },
  // H-2 framework demos — generic CollectionSubContainer + native frame/transform application.
  { key: 'h2-radial',     label: 'Radial (H-2)',     detail: 'H-2 · radial layout · native frame + transform per scroll tick · 1 JSI batch' },
  { key: 'h2-carousel3d', label: 'Carousel (H-2)',   detail: 'H-2 · cover-flow · perspective rotateY · native CATransform3D' },
  { key: 'h2-spiral',     label: 'Spiral (H-2)',     detail: 'H-2 · Archimedean spiral · scroll unwinds · scale + opacity per item' },
  { key: 'h2-hex',        label: 'Hex (H-2)',        detail: 'H-2 · honeycomb tiling · static layout · scrollDirection=none' },
];

// Which tabs benefit visually from the resize toggle
const RESIZE_TABS: DemoTab[] = ['grid-v', 'masonry-v', 'list-v', 'flow-v', 'compose', 'lab'];

export default function RiffDemo() {
  const [tab, setTab] = useState<DemoTab>('list-v');
  const widthAnim = useRef(new Animated.Value(1)).current;
  const [isNarrow, setIsNarrow] = useState(false);

  const toggleWidth = () => {
    const toValue = isNarrow ? 1 : 0;
    setIsNarrow(!isNarrow);
    Animated.spring(widthAnim, {
      toValue,
      useNativeDriver: false,
      tension: 80,
      friction: 16,
    }).start();
  };

  const resizeRelevant = RESIZE_TABS.includes(tab);

  return (
    <View style={S.root}>
      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={S.tabBarScroll}
        contentContainerStyle={S.tabBar}
      >
        {TABS.map(t => (
          <Pressable
            key={t.key}
            style={[S.tab, tab === t.key && S.tabActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[S.tabLabel, tab === t.key && S.tabLabelActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Detail line + resize toggle */}
      <View style={S.detailBar}>
        <Text style={S.detailText} numberOfLines={1}>
          {TABS.find(t => t.key === tab)?.detail}
        </Text>
        <Pressable
          style={[S.resizeBtn, !resizeRelevant && S.resizeBtnDim]}
          onPress={resizeRelevant ? toggleWidth : undefined}
        >
          <Text style={S.resizeBtnText}>{isNarrow ? '◀▶' : '▶◀'}</Text>
        </Pressable>
      </View>

      {/* Content with animated width */}
      <View style={S.contentOuter}>
        <Animated.View style={[S.content, {
          width: widthAnim.interpolate({
            inputRange:  [0, 1],
            outputRange: ['60%', '100%'],
          }),
        }]}>
          {tab === 'list-v'    && <ListDemo />}
          {tab === 'list-h'    && <HorizontalListDemo />}
          {tab === 'grid-v'    && <GridDemo />}
          {tab === 'grid-h'    && <HorizontalGridDemo />}
          {tab === 'masonry-v' && <MasonryDemo />}
          {tab === 'flow-v'    && <FlowDemo />}
          {tab === 'compose'  && <CompositionalDemo />}
          {tab === 'lab'      && <CompositionalLab />}

          {tab === 'circular' && (
            <CircularList
              data={CIRCULAR_DATA}
              itemSize={70}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <View style={[S.circularCell, { backgroundColor: item.color }]}>
                  <Text style={S.circularText}>{item.label}</Text>
                </View>
              )}
            />
          )}

          {tab === 'carousel' && (
            <Carousel3D
              data={CAROUSEL_DATA}
              itemWidth={160}
              itemHeight={200}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <View style={[S.carouselCard, { backgroundColor: item.color }]}>
                  <Text style={S.carouselTitle}>{item.title}</Text>
                </View>
              )}
            />
          )}

          {/* H-2 framework demos. Each uses CollectionSubContainer + a layout
              from src/layouts/. Frames + transforms are applied natively by
              CollectionSubContainerShadowNode → RNCollectionSubContainerView. */}
          {tab === 'h2-radial' && (
            <CollectionSubContainer
              layout={radial({ radius: 130, itemSize: 70, scrollPerRevolution: 700 })}
              data={RADIAL_DATA}
              keyExtractor={(item) => `radial-${item.id}`}
              sectionIndex={0}
              style={S.h2Container}
              renderItem={({ item }) => (
                <View style={[S.circularCell, { backgroundColor: item.color }]}>
                  <Text style={S.circularText}>{item.label}</Text>
                </View>
              )}
            />
          )}

          {tab === 'h2-carousel3d' && (
            <CollectionSubContainer
              layout={carousel3DLayout({ itemSize: 200, gap: 28, perspective: 700, maxRotation: 55 })}
              data={CAROUSEL3D_DATA}
              keyExtractor={(item) => `c3d-${item.id}`}
              sectionIndex={0}
              crossAxisSize={260}
              style={S.h2CarouselWrap}
              renderItem={({ item }) => (
                <View style={[S.carouselCard, { backgroundColor: item.color }]}>
                  <Text style={S.carouselTitle}>{item.title}</Text>
                </View>
              )}
            />
          )}

          {tab === 'h2-spiral' && (
            <CollectionSubContainer
              layout={spiral({ a: 10, b: 14, angularStep: 0.55, itemSize: 56, scrollPerRevolution: 800 })}
              data={SPIRAL_DATA}
              keyExtractor={(item) => `sp-${item.id}`}
              sectionIndex={0}
              style={S.h2Container}
              renderItem={({ item }) => (
                <View style={[S.circularCell, { backgroundColor: item.color }]}>
                  <Text style={S.spiralText}>{item.label}</Text>
                </View>
              )}
            />
          )}

          {tab === 'h2-hex' && (
            <CollectionSubContainer
              layout={hex({ hexSize: 64, paddingX: 12, paddingY: 12, gap: 6 })}
              data={HEX_DATA}
              keyExtractor={(item) => `hex-${item.id}`}
              sectionIndex={0}
              scrollDirection="none"
              style={S.h2Container}
              renderItem={({ item }) => (
                <View style={[S.hexCell, { backgroundColor: item.color }]}>
                  <Text style={S.hexText}>{item.label}</Text>
                </View>
              )}
            />
          )}
        </Animated.View>
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root:           { flex: 1, backgroundColor: '#0a0a0a' },

  tabBarScroll:   { flexGrow: 0, backgroundColor: '#111' },
  tabBar:         { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  tab:            { paddingVertical: 7, paddingHorizontal: 16, borderRadius: 8,
                    backgroundColor: '#1a1a1a' },
  tabActive:      { backgroundColor: '#14532d' },
  tabLabel:       { fontSize: 12, fontWeight: '600', color: '#666' },
  tabLabelActive: { color: '#4ade80' },

  detailBar:      { flexDirection: 'row', alignItems: 'center',
                    paddingLeft: 12, paddingRight: 6, paddingVertical: 5,
                    backgroundColor: '#0d0d0d',
                    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  detailText:     { flex: 1, fontSize: 11, color: '#444' },
  resizeBtn:      { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6,
                    backgroundColor: '#1a1a1a', marginLeft: 6 },
  resizeBtnDim:   { opacity: 0.3 },
  resizeBtnText:  { fontSize: 11, fontWeight: '700', color: '#4ade80' },

  contentOuter:   { flex: 1 },
  content:        { flex: 1 },

  circularCell:   { flex: 1, borderRadius: 35, alignItems: 'center', justifyContent: 'center' },
  circularText:   { fontSize: 20, fontWeight: '700', color: '#fff' },
  carouselCard:   { flex: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  carouselTitle:  { fontSize: 20, fontWeight: '700', color: '#fff' },

  h2Container:    { flex: 1, backgroundColor: '#0a0a0a' },
  h2CarouselWrap: { height: 260, marginTop: 20, backgroundColor: '#0a0a0a' },
  spiralText:     { fontSize: 14, fontWeight: '700', color: '#fff' },
  hexCell:        { flex: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  hexText:        { fontSize: 14, fontWeight: '700', color: '#fff' },
});
