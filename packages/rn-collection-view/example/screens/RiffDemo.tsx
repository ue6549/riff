/**
 * Riff Demo — standalone showcase of all layout types.
 *
 * Each tab demos a specific layout engine with vertical variants,
 * decorations, mutations, and sticky headers where applicable.
 * Custom layout tabs show circular arc and 3D carousel.
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

type DemoTab = 'list-v' | 'list-h' | 'grid-v' | 'grid-h' | 'masonry-v' | 'flow-v' | 'circular' | 'carousel' | 'compose';

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];
const CIRCULAR_DATA = Array.from({ length: 12 }, (_, i) => ({ id: i, label: `${i}`, color: COLORS[i % COLORS.length]! }));
const CAROUSEL_DATA = Array.from({ length: 8 }, (_, i) => ({ id: i, title: `Card ${i}`, color: COLORS[i % COLORS.length]! }));

const TABS: { key: DemoTab; label: string; detail: string }[] = [
  { key: 'list-v',    label: 'List ↕',    detail: 'Vertical · sections · decorations · mutations · sticky' },
  { key: 'list-h',    label: 'List ↔',    detail: 'Horizontal · sections · fixed-width cards' },
  { key: 'grid-v',    label: 'Grid ↕',    detail: 'Grid · responsive columns (3→2→1) · sticky · section bkg · mutations · MVC' },
  { key: 'grid-h',    label: 'Grid ↔',    detail: 'Horizontal grid · columns=2 · section backgrounds · insert/delete · MVC' },
  { key: 'masonry-v', label: 'Masonry ↕', detail: 'Masonry · responsive columns (2→1) · sticky · section bkg · mutations · MVC' },
  { key: 'flow-v',    label: 'Flow ↕',    detail: 'Flow · product cards + tags · two-pass · sticky · section bkg · mutations · MVC' },
  { key: 'circular',  label: 'Radial',    detail: 'Radial arc · TS custom layout · arbitrary (x, y) — impossible in FlashList' },
  { key: 'carousel',  label: '3D Carousel', detail: '3D perspective carousel · TS custom layout · rotateY + scale per item' },
  { key: 'compose',   label: 'Compose ↕',  detail: 'Compositional · list + grid + flow + masonry · one scroll · shared recycling pool' },
];

// Which tabs benefit visually from the resize toggle
const RESIZE_TABS: DemoTab[] = ['grid-v', 'masonry-v', 'list-v', 'flow-v', 'compose'];

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
});
