/**
 * Search Comparison Tab — 1500 homogeneous search result items.
 *
 * Simple icon + title + subtitle rows at fixed 56px height.
 * FlashList's strongest case: uniform height, single item type, perfect for recycling.
 *
 * Shows Riff is competitive even against FlashList's best-case scenario.
 * Key: identity-based rendering avoids the recycling-artifact flash on fast scroll.
 *
 * PerfHood shows JS FPS, mount count, and render count during the session.
 */
import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '../../components/CollectionView';
import { list } from '@riff/layouts';
import { PerfHood } from '../../components/PerfHood';

// ── Data ──────────────────────────────────────────────────────────────────────

const COUNT = 1500;
const ITEM_H = 56;

const ICONS = ['🎵', '🎬', '📚', '🛍', '🍕', '✈️', '🏠', '💻', '⚽', '🎮'];
const CATEGORIES = ['Music', 'Video', 'Books', 'Shopping', 'Food', 'Travel', 'Real Estate', 'Tech', 'Sports', 'Gaming'];
const SUBTITLES = [
  'Trending · 2.3M results',
  'Updated today · 840K results',
  'Popular in your region',
  '1.1M results · Sponsored',
  'Recently searched',
  'Based on your history',
  '4.5★ · 12K reviews',
  'Top result · Verified',
  '320K results',
  'Breaking · 15 min ago',
];

interface SearchItem {
  id: number;
  icon: string;
  title: string;
  subtitle: string;
  color: string;
}

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];

const SEARCH_DATA: SearchItem[] = Array.from({ length: COUNT }, (_, i) => ({
  id: i,
  icon: ICONS[i % ICONS.length]!,
  title: `${CATEGORIES[i % CATEGORIES.length]} Result #${i + 1}`,
  subtitle: SUBTITLES[i % SUBTITLES.length]!,
  color: COLORS[i % COLORS.length]!,
}));

// ── Cell ──────────────────────────────────────────────────────────────────────

function SearchCell({ item }: { item: SearchItem }) {
  return (
    <View style={C.row}>
      <View style={[C.iconBox, { backgroundColor: item.color + '22' }]}>
        <Text style={C.icon}>{item.icon}</Text>
      </View>
      <View style={C.textArea}>
        <Text style={C.title} numberOfLines={1}>{item.title}</Text>
        <Text style={C.subtitle} numberOfLines={1}>{item.subtitle}</Text>
      </View>
      <Text style={C.chevron}>›</Text>
    </View>
  );
}

// ── Mount tracking ────────────────────────────────────────────────────────────

let searchTotalMounts  = 0;
let searchActiveMounts = 0;

export function resetSearchMounts() { searchTotalMounts = 0; searchActiveMounts = 0; }

function TrackedSearchCell({ item }: { item: SearchItem }) {
  const mounted = useRef(false);
  if (!mounted.current) { mounted.current = true; searchTotalMounts++; searchActiveMounts++; }
  React.useEffect(() => { return () => { searchActiveMounts--; }; }, []);
  return <SearchCell item={item} />;
}

// ── Tab ───────────────────────────────────────────────────────────────────────

const LAYOUT = list({ itemHeight: ITEM_H });

export default function SearchComparisonTab({ mode }: { mode: 'cv' | 'flash' }) {
  const renderCount     = useRef(0);
  const prevOffsetRef   = useRef(0);
  const prevTimeRef     = useRef(0);
  const listRef         = useRef<any>(null);
  const [velocity,      setVelocity] = useState(0);
  const [contentHeight, setContentH] = useState(0);
  const [, setTick] = useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  const handleScroll = (e: any) => {
    const offset = e.nativeEvent.contentOffset.y;
    const now    = Date.now();
    const dt     = now - prevTimeRef.current;
    if (dt > 0 && dt < 300) {
      const vel = Math.abs(offset - prevOffsetRef.current) / (dt / 1000);
      setVelocity(Math.round(vel));
    }
    prevOffsetRef.current = offset;
    prevTimeRef.current   = now;
  };

  const renderItem = ({ item }: { item: SearchItem }) => {
    renderCount.current++;
    return <TrackedSearchCell item={item} />;
  };

  const perfHood = (
    <PerfHood
      activeMounts={searchActiveMounts}
      totalMounts={searchTotalMounts}
      scrollVelocity={velocity}
      scrollRef={listRef}
      engine={mode === 'cv' ? 'riff' : 'flash'}
      tab="search"
      itemCount={SEARCH_DATA.length}
      itemHeight={ITEM_H}
      contentHeight={contentHeight}
    />
  );

  if (mode === 'flash') {
    return (
      <View style={T.root}>
        <FlashList
          ref={listRef}
          data={SEARCH_DATA}
          keyExtractor={item => String(item.id)}
          renderItem={renderItem}
          estimatedItemSize={ITEM_H}
          getItemType={() => 'search-row'}
          overrideItemLayout={layout => { layout.size = ITEM_H; }}
          onScroll={handleScroll}
          scrollEventThrottle={100}
          onContentSizeChange={(_, h) => setContentH(h)}
        />
        {perfHood}
      </View>
    );
  }

  return (
    <View style={T.root}>
      <Riff
        ref={listRef}
        data={SEARCH_DATA}
        keyExtractor={item => String(item.id)}
        renderItem={renderItem}
        layout={LAYOUT}
        scrollViewProps={{
          onScroll: handleScroll,
          scrollEventThrottle: 100,
          onContentSizeChange: (_, h) => setContentH(h),
        }}
      />
      {perfHood}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const T = StyleSheet.create({
  root: { flex: 1 },
});

const C = StyleSheet.create({
  row: {
    height: ITEM_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
    backgroundColor: '#0e0e0e',
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon:     { fontSize: 18 },
  textArea: { flex: 1, justifyContent: 'center', gap: 2 },
  title:    { fontSize: 13, fontWeight: '600', color: '#ddd' },
  subtitle: { fontSize: 11, color: '#555' },
  chevron:  { fontSize: 18, color: '#333', fontWeight: '300' },
});
