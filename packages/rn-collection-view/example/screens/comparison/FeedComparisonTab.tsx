/**
 * Feed Comparison Tab — 150 heterogeneous feed items.
 *
 * Cell types: image card, text post, multi-image row, action bar, banner ad.
 * Each cell has 5-10 nested Views to simulate real-world feed hierarchy.
 *
 * Key differentiators shown:
 * - FlashList forces `getItemType` + `overrideItemLayout` for correct rendering.
 *   It still recycles wrong types briefly on fling, causing flickers.
 * - Riff renders each cell with its real identity — no recycling artifacts.
 * - Deep hierarchy (5-10 Views deep) stresses JS bridge in FlashList recycling.
 */
import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '../../components/CollectionView';
import { list } from '@riff/layouts';
import { PerfHood } from '../../components/PerfHood';

// ── Item types ────────────────────────────────────────────────────────────────

type ItemType = 'image-card' | 'text-post' | 'multi-image' | 'action-bar' | 'banner';

interface FeedItem {
  id: number;
  type: ItemType;
  authorName: string;
  authorHandle: string;
  timestamp: string;
  color: string;
  text?: string;
  imageCount?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  bannerLabel?: string;
}

// ── Data ──────────────────────────────────────────────────────────────────────

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d', '#6a4c93', '#1982c4'];
const NAMES = ['Alex M', 'Priya K', 'Sam T', 'Jordan B', 'Casey L', 'Morgan W', 'Taylor R', 'Drew S'];
const HANDLES = ['@alexm', '@priyak', '@samt', '@jordanb', '@caseyl', '@morganw', '@taylorr', '@drews'];
const TIMES = ['2m', '8m', '15m', '32m', '1h', '2h', '4h', '1d'];
const ITEM_TYPES: ItemType[] = ['image-card', 'text-post', 'multi-image', 'action-bar', 'banner'];
const TEXTS = [
  'Just shipped a new feature that took three attempts to get right. Sometimes persistence pays off.',
  'Hot take: the best code is the code you never write.',
  'Spent 4 hours debugging only to find a missing semicolon. Classic.',
  'The hardest part of programming isn\'t the code — it\'s the naming.',
  'Ship early, iterate fast. But also: don\'t break prod.',
  'Watching the FPS counter go from 45 to 60 after an optimization is peak developer joy.',
  'Every senior engineer was once a junior who shipped something that broke prod on a Friday.',
];

const FEED_DATA: FeedItem[] = Array.from({ length: 1000 }, (_, i) => {
  const type = ITEM_TYPES[i % ITEM_TYPES.length]!;
  return {
    id: i,
    type,
    authorName: NAMES[i % NAMES.length]!,
    authorHandle: HANDLES[i % HANDLES.length]!,
    timestamp: TIMES[i % TIMES.length]!,
    color: COLORS[i % COLORS.length]!,
    text: type === 'text-post' || type === 'image-card' ? TEXTS[i % TEXTS.length] : undefined,
    imageCount: type === 'multi-image' ? (2 + (i % 3)) : undefined,
    likes: 10 + (i * 7) % 300,
    comments: (i * 3) % 80,
    shares: (i * 2) % 40,
    bannerLabel: type === 'banner' ? `Sponsored · Item ${i}` : undefined,
  };
});

// Heights for FlashList overrideItemLayout
const TYPE_HEIGHTS: Record<ItemType, number> = {
  'image-card': 220,
  'text-post':  110,
  'multi-image': 180,
  'action-bar': 56,
  'banner':     80,
};

// ── Cell components ───────────────────────────────────────────────────────────

function AuthorRow({ item }: { item: FeedItem }) {
  return (
    <View style={C.authorRow}>
      <View style={[C.avatar, { backgroundColor: item.color }]}>
        <Text style={C.avatarText}>{item.authorName[0]}</Text>
      </View>
      <View style={C.authorInfo}>
        <Text style={C.authorName}>{item.authorName}</Text>
        <Text style={C.authorMeta}>{item.authorHandle} · {item.timestamp}</Text>
      </View>
    </View>
  );
}

function ActionRow({ item }: { item: FeedItem }) {
  return (
    <View style={C.actionRow}>
      <View style={C.actionBtn}>
        <Text style={C.actionIcon}>♥</Text>
        <Text style={C.actionCount}>{item.likes}</Text>
      </View>
      <View style={C.actionBtn}>
        <Text style={C.actionIcon}>💬</Text>
        <Text style={C.actionCount}>{item.comments}</Text>
      </View>
      <View style={C.actionBtn}>
        <Text style={C.actionIcon}>↗</Text>
        <Text style={C.actionCount}>{item.shares}</Text>
      </View>
    </View>
  );
}

function ImageCard({ item }: { item: FeedItem }) {
  return (
    <View style={C.card}>
      <AuthorRow item={item} />
      <View style={[C.imageArea, { backgroundColor: item.color + '55' }]}>
        <View style={C.imagePlaceholder}>
          <Text style={C.imagePlaceholderText}>📷</Text>
        </View>
        <View style={C.imageCaption}>
          <Text style={C.captionText} numberOfLines={2}>{item.text}</Text>
        </View>
      </View>
      <ActionRow item={item} />
    </View>
  );
}

function TextPost({ item }: { item: FeedItem }) {
  return (
    <View style={C.card}>
      <AuthorRow item={item} />
      <View style={C.textBody}>
        <Text style={C.postText} numberOfLines={4}>{item.text}</Text>
      </View>
      <ActionRow item={item} />
    </View>
  );
}

function MultiImagePost({ item }: { item: FeedItem }) {
  const count = item.imageCount ?? 2;
  return (
    <View style={C.card}>
      <AuthorRow item={item} />
      <View style={C.multiImageRow}>
        {Array.from({ length: count }, (_, j) => (
          <View
            key={j}
            style={[C.multiImageThumb, { backgroundColor: COLORS[(item.id + j) % COLORS.length]! + '88' }]}
          >
            <Text style={C.imagePlaceholderText}>🖼</Text>
          </View>
        ))}
      </View>
      <ActionRow item={item} />
    </View>
  );
}

function ActionBarCell({ item }: { item: FeedItem }) {
  return (
    <View style={C.actionBarCell}>
      <View style={[C.smallAvatar, { backgroundColor: item.color }]}>
        <Text style={C.avatarText}>{item.authorName[0]}</Text>
      </View>
      <Text style={C.actionBarName}>{item.authorName}</Text>
      <View style={C.followBtn}>
        <Text style={C.followBtnText}>Follow</Text>
      </View>
    </View>
  );
}

function BannerCell({ item }: { item: FeedItem }) {
  return (
    <View style={[C.banner, { borderLeftColor: item.color }]}>
      <View style={C.bannerInner}>
        <View style={C.bannerIcon}>
          <Text>📢</Text>
        </View>
        <View style={C.bannerText}>
          <Text style={C.bannerLabel}>{item.bannerLabel}</Text>
          <Text style={C.bannerSub}>Tap to learn more about this promotion</Text>
        </View>
      </View>
    </View>
  );
}

function FeedCell({ item }: { item: FeedItem }) {
  switch (item.type) {
    case 'image-card':  return <ImageCard item={item} />;
    case 'text-post':   return <TextPost item={item} />;
    case 'multi-image': return <MultiImagePost item={item} />;
    case 'action-bar':  return <ActionBarCell item={item} />;
    case 'banner':      return <BannerCell item={item} />;
  }
}

// ── Mount tracking ────────────────────────────────────────────────────────────

let feedTotalMounts  = 0;
let feedActiveMounts = 0;
let feedBlankAreaPct = -1; // -1 = unavailable (FlashList)

export function resetFeedMounts() { feedTotalMounts = 0; feedActiveMounts = 0; }

function TrackedFeedCell({ item }: { item: FeedItem }) {
  const mounted = useRef(false);
  if (!mounted.current) { mounted.current = true; feedTotalMounts++; feedActiveMounts++; }
  // Decrement active count on unmount (cell leaves the render window).
  React.useEffect(() => { return () => { feedActiveMounts--; }; }, []);
  return <FeedCell item={item} />;
}

// ── Tab ───────────────────────────────────────────────────────────────────────

const LAYOUT = list({ estimatedItemHeight: 140 }); // measured by Yoga; estimate for Phase A windowing

export default function FeedComparisonTab({ mode }: { mode: 'cv' | 'flash' }) {
  const renderCount     = useRef(0);
  const prevOffsetRef   = useRef(0);
  const prevTimeRef     = useRef(0);
  const listRef         = useRef<any>(null);
  const vpHeightRef     = useRef(0);
  const [velocity,      setVelocity]     = useState(0);
  const [contentHeight, setContentH]     = useState(0);
  // Tick drives re-renders so PerfHood picks up latest module-level mount counters.
  const [, setTick] = useState(0);
  React.useEffect(() => {
    // Reset blank area when switching engines.
    feedBlankAreaPct = -1;
    const id = setInterval(() => setTick(t => t + 1), 500);
    return () => clearInterval(id);
  }, [mode]);

  const handleLayout = (e: LayoutChangeEvent) => {
    vpHeightRef.current = e.nativeEvent.layout.height;
  };

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

  const renderItem = ({ item }: { item: FeedItem }) => {
    renderCount.current++;
    return <TrackedFeedCell item={item} />;
  };

  const perfHood = (
    <PerfHood
      activeMounts={feedActiveMounts}
      totalMounts={feedTotalMounts}
      scrollVelocity={velocity}
      blankAreaPct={feedBlankAreaPct}
      scrollRef={listRef}
      engine={mode === 'cv' ? 'riff' : 'flash'}
      tab="feed"
      itemCount={FEED_DATA.length}
      itemHeight={140}
      contentHeight={contentHeight}
    />
  );

  if (mode === 'flash') {
    return (
      <View style={T.root} onLayout={handleLayout}>
        <FlashList
          ref={listRef}
          data={FEED_DATA}
          keyExtractor={item => String(item.id)}
          renderItem={renderItem}
          estimatedItemSize={140}
          getItemType={item => item.type}
          overrideItemLayout={(layout, item) => { layout.size = TYPE_HEIGHTS[item.type]; }}
          onScroll={handleScroll}
          scrollEventThrottle={100}
          onContentSizeChange={(_, h) => setContentH(h)}
        />
        {perfHood}
      </View>
    );
  }

  return (
    <View style={T.root} onLayout={handleLayout}>
      <Riff
        handle={listRef}
        data={FEED_DATA}
        keyExtractor={item => String(item.id)}
        renderItem={renderItem}
        layout={LAYOUT}
        onBlankArea={({ offsetStart, offsetEnd }) => {
          const vpH = vpHeightRef.current;
          feedBlankAreaPct = vpH > 0
            ? Math.round((offsetStart + offsetEnd) / vpH * 100)
            : 0;
        }}
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
  // Card wrapper
  card: {
    backgroundColor: '#111',
    marginHorizontal: 12,
    marginVertical: 5,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#222',
  },

  // Author row
  authorRow:   { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 10 },
  avatar:      { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  smallAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarText:  { fontSize: 14, fontWeight: '700', color: '#fff' },
  authorInfo:  { flex: 1 },
  authorName:  { fontSize: 13, fontWeight: '600', color: '#e0e0e0' },
  authorMeta:  { fontSize: 11, color: '#555', marginTop: 1 },

  // Image card
  imageArea:        { marginHorizontal: 10, borderRadius: 8, overflow: 'hidden', height: 120 },
  imagePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  imagePlaceholderText: { fontSize: 28 },
  imageCaption:     { position: 'absolute', bottom: 0, left: 0, right: 0,
                      backgroundColor: 'rgba(0,0,0,0.5)', padding: 8 },
  captionText:      { fontSize: 12, color: '#e0e0e0' },

  // Text post
  textBody: { paddingHorizontal: 12, paddingBottom: 4 },
  postText:  { fontSize: 14, color: '#ccc', lineHeight: 20 },

  // Multi-image
  multiImageRow:  { flexDirection: 'row', gap: 4, paddingHorizontal: 10, height: 100 },
  multiImageThumb: { flex: 1, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },

  // Action row
  actionRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 16 },
  actionBtn:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionIcon: { fontSize: 14, color: '#555' },
  actionCount:{ fontSize: 12, color: '#555' },

  // Action bar cell (suggested follows)
  actionBarCell: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
                   paddingVertical: 12, backgroundColor: '#111', borderBottomWidth: StyleSheet.hairlineWidth,
                   borderBottomColor: '#1e1e1e', gap: 10 },
  actionBarName: { flex: 1, fontSize: 13, fontWeight: '600', color: '#ccc' },
  followBtn:     { paddingVertical: 5, paddingHorizontal: 14, borderRadius: 14,
                   backgroundColor: '#1e3a1e' },
  followBtnText: { fontSize: 12, fontWeight: '600', color: '#4ade80' },

  // Banner
  banner: { marginHorizontal: 12, marginVertical: 5, borderRadius: 8, backgroundColor: '#141414',
            borderLeftWidth: 3, overflow: 'hidden' },
  bannerInner: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  bannerIcon:  { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  bannerText:  { flex: 1 },
  bannerLabel: { fontSize: 13, fontWeight: '600', color: '#bbb' },
  bannerSub:   { fontSize: 11, color: '#555', marginTop: 2 },
});
