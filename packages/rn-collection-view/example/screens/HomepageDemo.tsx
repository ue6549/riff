/**
 * Homepage Demo — Flipkart/Amazon-style homepage benchmark
 *
 * Riff (compositional layout) vs FlashList (nested ScrollViews + manual grids).
 * 8 sections mixing H lists, V grids, and masonry — the kind of page that
 * every large e-commerce app ships and every RN team struggles to build.
 *
 * Sections:
 *   S0 — Category icons    — H list, sticky SearchBar header
 *   S1 — Banner carousel   — H list of promo banners
 *   S2 — Deals of the Day  — 2-col V grid, header + footer, section bg
 *   S3 — Recently Viewed   — H list
 *   S4 — Shop by Category  — 3-col V grid of CategoryChips
 *   S5 — Trending Now      — H list
 *   S6 — Featured Brands   — H list of banner cards
 *   S7 — Recommended       — masonry 2-col (Riff) / grid 2-col (FlashList), sticky header + footer, section bg
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '../components/CollectionView';
import { compositional } from '@riff/layouts/compositional';
import { list } from '@riff/layouts/list';
import { grid } from '@riff/layouts/grid';
import { masonry } from '@riff/layouts/masonry';
import type { SectionConfig } from '@riff/types/protocol';
import { PerfHood } from '../components/PerfHood';
import {
  ProductItem, BannerItem, CategoryItem,
  makeProduct, makeBanner, makeCategory,
  ProductCard, TrackedProductCard, BannerCard, CategoryChip, SearchBar,
  SectionHeader, SectionFooter,
  HEADER_H, FOOTER_H,
  createMountTracker,
  S,
} from './benchmarkShared';

// ── Mount tracker (module-level, shared by both engines) ────────────────────

const tracker = createMountTracker();

// ── Tracked wrappers for non-product items ──────────────────────────────────

function TrackedBannerCard({ item, onMount }: { item: BannerItem; onMount: () => () => void }) {
  useEffect(() => onMount(), []);
  return <BannerCard item={item} />;
}

function TrackedCategoryChip({ item, onMount }: { item: CategoryItem; onMount: () => () => void }) {
  useEffect(() => onMount(), []);
  return <CategoryChip item={item} />;
}

// ── Section data ────────────────────────────────────────────────────────────

const S0_DATA = Array.from({ length: 12 }, (_, i) => makeCategory(`hp-cat-${i}`, i));
const S1_DATA = Array.from({ length: 5 }, (_, i) => makeBanner(`hp-ban-${i}`, i));
const S2_DATA = Array.from({ length: 8 }, (_, i) => makeProduct(`hp-deals-${i}`, i));
const S3_DATA = Array.from({ length: 10 }, (_, i) => makeProduct(`hp-recent-${i}`, i + 20));
const S4_DATA = Array.from({ length: 9 }, (_, i) => makeCategory(`hp-shopcat-${i}`, i));
const S5_DATA = Array.from({ length: 8 }, (_, i) => makeProduct(`hp-trend-${i}`, i + 40));
const S6_DATA = Array.from({ length: 6 }, (_, i) => makeBanner(`hp-brand-${i}`, i + 10));
const S7_DATA = Array.from({ length: 60 }, (_, i) => makeProduct(`hp-reco-${i}`, i + 60));

const ALL_SECTIONS = [
  { key: 'categories',      title: 'Categories',           data: S0_DATA },
  { key: 'banners',         title: 'Banner Carousel',      data: S1_DATA },
  { key: 'deals',           title: 'Deals of the Day',     data: S2_DATA },
  { key: 'recent',          title: 'Recently Viewed',       data: S3_DATA },
  { key: 'shop-by-cat',     title: 'Shop by Category',     data: S4_DATA },
  { key: 'trending',        title: 'Trending Now',          data: S5_DATA },
  { key: 'featured-brands', title: 'Featured Brands',      data: S6_DATA },
  { key: 'recommended',     title: 'Recommended for You',  data: S7_DATA },
];

const TOTAL_ITEMS = 12 + 5 + 8 + 10 + 9 + 8 + 6 + 60; // 118

// ═══════════════════════════════════════════════════════════════════════════════
// Riff implementation — single CollectionView, compositional layout
// ═══════════════════════════════════════════════════════════════════════════════

function RiffHomepage({ listRef }: { listRef: React.RefObject<any> }) {
  const SECTION_BG_COLORS = ['#f0f2f5', '#f5f2f0'];

  const layout = useMemo(() => compositional([
    // S0: Category icons — H list, SearchBar as section header
    // estimatedCrossAxisHeight = chip height (~80px) to avoid 200px default → empty space
    { range: 0, layout: list({ estimatedItemHeight: 72, headerHeight: 50, itemSpacing: 0, estimatedCrossAxisHeight: 80 }), horizontal: true },
    // S1: Banner carousel — H list (280px wide banners, ~180px tall)
    { range: 1, layout: list({ estimatedItemHeight: 280, headerHeight: HEADER_H, footerHeight: FOOTER_H, itemSpacing: 8, sectionSpacing: 12, estimatedCrossAxisHeight: 180 }), horizontal: true },
    // S2: Deals of the Day — 2-col V grid, section bg
    { range: 2, layout: grid({ columns: 2, rowHeight: 200, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: true, sectionSpacing: 12 }) },
    // S3: Recently Viewed — H list (180px wide product cards, ~350px tall)
    { range: 3, layout: list({ estimatedItemHeight: 180, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 12, estimatedCrossAxisHeight: 350 }), horizontal: true },
    // S4: Shop by Category — 3-col V grid
    { range: 4, layout: grid({ columns: 3, rowHeight: 90, columnSpacing: 8, rowSpacing: 8, headerHeight: HEADER_H, sectionSpacing: 12 }) },
    // S5: Trending Now — H list (180px wide product cards, ~350px tall)
    { range: 5, layout: list({ estimatedItemHeight: 180, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 12, estimatedCrossAxisHeight: 350 }), horizontal: true },
    // S6: Featured Brands — H list of banners (280px wide, ~180px tall)
    { range: 6, layout: list({ estimatedItemHeight: 280, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 12, estimatedCrossAxisHeight: 180 }), horizontal: true },
    // S7: Recommended — 2-col masonry, section bg
    { range: 7, layout: masonry({ columns: 2, heightForItem: () => 180, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, sectionBackground: true, sectionSpacing: 12 }) },
  ]), []);

  const SECTION_META = [
    { subtitle: 'list H — category icons' },
    { subtitle: 'list H — promo banners' },
    { subtitle: 'grid V — 2 columns' },
    { subtitle: 'list H — recent products' },
    { subtitle: 'grid V — 3 columns' },
    { subtitle: 'list H — trending products' },
    { subtitle: 'list H — brand banners' },
    { subtitle: 'masonry V — 2 columns' },
  ];

  const sections = useMemo<SectionConfig<any>[]>(() =>
    ALL_SECTIONS.map((sec, i) => {
      const base: any = {
        key: sec.key,
        data: sec.data,
        insets: { top: 8, bottom: 8, left: 10, right: 10 },
      };

      base.header = i === 0
        ? { render: () => <SearchBar />, height: 50 }
        : { render: () => <SectionHeader title={sec.title} count={sec.data.length} subtitle={SECTION_META[i]!.subtitle} />, height: HEADER_H };

      // Footers on S1, S2, S7
      if (i === 1 || i === 2 || i === 7) {
        const color = i === 1 ? '#457b9d' : i === 2 ? (S2_DATA[0]?.color ?? '#e63946') : (S7_DATA[0]?.color ?? '#264653');
        base.footer = {
          render: () => <SectionFooter label={`${sec.data.length} items`} color={color} />,
          height: FOOTER_H,
        };
      }

      return base;
    }),
  []);

  type AnyItem = ProductItem | BannerItem | CategoryItem;

  const keyExtractor = useCallback((item: AnyItem) => item.id, []);
  const getItemType = useCallback((item: AnyItem) => item._type, []);

  const renderItem = useCallback(({ item }: { item: AnyItem }) => {
    if (item._type === 'category') {
      return <TrackedCategoryChip item={item} onMount={tracker.onMount} />;
    }
    if (item._type === 'banner') {
      return <TrackedBannerCard item={item} onMount={tracker.onMount} />;
    }
    return <TrackedProductCard item={item} onMount={tracker.onMount} />;
  }, []);

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <View style={{
        position: 'absolute', left: frame.x, top: frame.y,
        width: frame.width, height: frame.height,
        backgroundColor: SECTION_BG_COLORS[sectionIndex % SECTION_BG_COLORS.length],
        borderRadius: 8,
      }} />
    ),
  }), []);

  return (
    <Riff
      handle={listRef}
      sections={sections}
      layout={layout}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      renderItem={renderItem}
      renderMultiplier={0.25}
      hRenderMultiplier={1.0}
      decorationRenderers={decorationRenderers}
      onBlankArea={({ offsetStart, offsetEnd }) => {
        const vpH = tracker.getVpH();
        tracker.setBlank(vpH > 0 ? Math.round((offsetStart + offsetEnd) / vpH * 100) : 0);
      }}
      scrollViewProps={{
        contentInsetAdjustmentBehavior: 'automatic',
        onScroll: tracker.onScroll,
        scrollEventThrottle: 100,
        onContentSizeChange: (_: number, h: number) => { tracker.setContentH(h); },
      }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FlashList implementation — outer vertical FlashList + nested H lists + manual grids
// ═══════════════════════════════════════════════════════════════════════════════

type FlashFlatItem =
  | { _id: string; _type: 'header'; sectionIndex: number; title: string; subtitle: string; count: number }
  | { _id: string; _type: 'search-header'; sectionIndex: number }
  | { _id: string; _type: 'footer'; sectionIndex: number; label: string; color: string }
  | { _id: string; _type: 'content'; sectionIndex: number; data: any[] };

const FLASH_SUBTITLES = [
  'ScrollView H — category icons',
  'nested FlashList H — banners',
  'mapped Views — grid 2-col',
  'nested FlashList H',
  'mapped Views — grid 3-col',
  'nested FlashList H',
  'nested FlashList H — banners',
  'mapped Views — grid 2-col (FlashList has no masonry)',
];

const FLASH_FLAT_DATA: FlashFlatItem[] = [];

ALL_SECTIONS.forEach((sec, i) => {
  // S0 has SearchBar header; others have regular section headers
  if (i === 0) {
    FLASH_FLAT_DATA.push({ _id: `search-header-${i}`, _type: 'search-header', sectionIndex: i });
  } else {
    FLASH_FLAT_DATA.push({
      _id: `header-${i}`, _type: 'header', sectionIndex: i,
      title: sec.title, subtitle: FLASH_SUBTITLES[i]!, count: sec.data.length,
    });
  }

  // Content
  FLASH_FLAT_DATA.push({
    _id: `content-${i}`, _type: 'content', sectionIndex: i, data: sec.data,
  });

  // Footers on S1, S2, S7
  if (i === 1 || i === 2 || i === 7) {
    const color = i === 1 ? (S1_DATA[0]?.color ?? '#e63946')
      : i === 2 ? (S2_DATA[0]?.color ?? '#e63946')
      : (S7_DATA[0]?.color ?? '#264653');
    FLASH_FLAT_DATA.push({
      _id: `footer-${i}`, _type: 'footer', sectionIndex: i,
      label: `${sec.data.length} items`, color,
    });
  }
});

// ── FlashList section renderers ─────────────────────────────────────────────

function FlashHSection({ data }: { data: ProductItem[] }) {
  const renderItem = useCallback(({ item }: { item: ProductItem }) => (
    <View style={S.hCardWrapper}>
      <TrackedProductCard item={item} onMount={tracker.onMount} />
    </View>
  ), []);
  return (
    <FlashList
      horizontal
      data={data}
      keyExtractor={item => item.id}
      renderItem={renderItem}
      estimatedItemSize={180}
      showsHorizontalScrollIndicator={false}
    />
  );
}

function FlashHBannerSection({ data }: { data: BannerItem[] }) {
  const renderItem = useCallback(({ item }: { item: BannerItem }) => (
    <View style={S.bannerWrapper}>
      <TrackedBannerCard item={item} onMount={tracker.onMount} />
    </View>
  ), []);
  return (
    <FlashList
      horizontal
      data={data}
      keyExtractor={item => item.id}
      renderItem={renderItem}
      estimatedItemSize={280}
      showsHorizontalScrollIndicator={false}
    />
  );
}

function FlashGridSection({ data, columns }: { data: ProductItem[]; columns: number }) {
  const rows: ProductItem[][] = [];
  for (let i = 0; i < data.length; i += columns) {
    rows.push(data.slice(i, i + columns));
  }
  return (
    <View>
      {rows.map((row, ri) => (
        <View key={ri} style={S.gridRow}>
          {row.map(item => (
            <View key={item.id} style={S.gridCell}>
              <TrackedProductCard item={item} onMount={tracker.onMount} />
            </View>
          ))}
          {row.length < columns && <View style={S.gridCell} />}
        </View>
      ))}
    </View>
  );
}

function FlashCategoryGridSection({ data, columns }: { data: CategoryItem[]; columns: number }) {
  const rows: CategoryItem[][] = [];
  for (let i = 0; i < data.length; i += columns) {
    rows.push(data.slice(i, i + columns));
  }
  return (
    <View>
      {rows.map((row, ri) => (
        <View key={ri} style={S.gridRow}>
          {row.map(item => (
            <View key={item.id} style={S.gridCell}>
              <TrackedCategoryChip item={item} onMount={tracker.onMount} />
            </View>
          ))}
          {row.length < columns && <View style={S.gridCell} />}
        </View>
      ))}
    </View>
  );
}

function FlashSectionContent({ sectionIndex, data }: { sectionIndex: number; data: any[] }) {
  return (
    <View style={LS.flashSection}>
      {sectionIndex === 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row' }}>
            {(data as CategoryItem[]).map(item => (
              <View key={item.id} style={S.categoryWrapper}>
                <TrackedCategoryChip item={item} onMount={tracker.onMount} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      {sectionIndex === 1 && <FlashHBannerSection data={data as BannerItem[]} />}
      {sectionIndex === 2 && <FlashGridSection data={data as ProductItem[]} columns={2} />}
      {sectionIndex === 3 && <FlashHSection data={data as ProductItem[]} />}
      {sectionIndex === 4 && <FlashCategoryGridSection data={data as CategoryItem[]} columns={3} />}
      {sectionIndex === 5 && <FlashHSection data={data as ProductItem[]} />}
      {sectionIndex === 6 && <FlashHBannerSection data={data as BannerItem[]} />}
      {sectionIndex === 7 && <FlashGridSection data={data as ProductItem[]} columns={2} />}
    </View>
  );
}

function FlashHomepage({ listRef }: { listRef: React.RefObject<any> }) {
  const renderItem = useCallback(({ item }: { item: FlashFlatItem }) => {
    if (item._type === 'search-header') {
      return <SearchBar />;
    }
    if (item._type === 'header') {
      return <SectionHeader title={item.title} count={item.count} subtitle={item.subtitle} />;
    }
    if (item._type === 'footer') {
      return <SectionFooter label={item.label} color={item.color} />;
    }
    return <FlashSectionContent sectionIndex={item.sectionIndex} data={item.data} />;
  }, []);

  return (
    <FlashList
      ref={listRef}
      data={FLASH_FLAT_DATA}
      keyExtractor={item => item._id}
      renderItem={renderItem}
      estimatedItemSize={300}
      getItemType={item => item._type}
      onScroll={tracker.onScroll}
      scrollEventThrottle={100}
      onContentSizeChange={(_: number, h: number) => { tracker.setContentH(h); }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main — engine toggle
// ═══════════════════════════════════════════════════════════════════════════════

type Engine = 'riff' | 'flash';

export default function HomepageDemo() {
  const [engine, setEngine] = useState<Engine>('riff');
  const listRef = useRef<any>(null);

  useLayoutEffect(() => { tracker.reset(); }, [engine]);

  const getActiveMounts   = useCallback(() => tracker.getActive(), []);
  const getTotalMounts    = useCallback(() => tracker.getTotal(), []);
  const getBlankAreaPct   = useCallback(() => tracker.getBlank(), []);
  const getScrollVelocity = useCallback(() => tracker.getVelocity(), []);
  const getContentHeight  = useCallback(() => tracker.getContentH(), []);

  return (
    <SafeAreaView style={LS.root}>
      <View style={LS.engineBar}>
        <Pressable
          style={[LS.engineBtn, engine === 'riff' && LS.engineBtnRiff]}
          onPress={() => setEngine('riff')}
        >
          <Text style={[LS.engineText, engine === 'riff' && LS.engineTextRiff]}>Riff</Text>
        </Pressable>
        <Pressable
          style={[LS.engineBtn, engine === 'flash' && LS.engineBtnFlash]}
          onPress={() => setEngine('flash')}
        >
          <Text style={[LS.engineText, engine === 'flash' && LS.engineTextFlash]}>FlashList</Text>
        </Pressable>
      </View>

      <View style={LS.content} onLayout={(e) => { tracker.setVpH(e.nativeEvent.layout.height); }}>
        {engine === 'riff'
          ? <RiffHomepage listRef={listRef} />
          : <FlashHomepage listRef={listRef} />}
      </View>

      <PerfHood
        getActiveMounts={getActiveMounts}
        getTotalMounts={getTotalMounts}
        getScrollVelocity={getScrollVelocity}
        getBlankAreaPct={getBlankAreaPct}
        scrollRef={listRef}
        engine={engine === 'riff' ? 'riff' : 'flash'}
        tab="homepage"
        itemCount={TOTAL_ITEMS}
        itemHeight={40}
        getContentHeight={getContentHeight}
      />
    </SafeAreaView>
  );
}

// ── Local styles (screen layout — card/section styles come from benchmarkShared) ─

const LS = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#f5f5f5' },
  content: { flex: 1 },

  // Engine toggle bar
  engineBar:       { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  engineBtn:       { flex: 1, paddingVertical: 6, borderRadius: 6, backgroundColor: '#e5e5e5', alignItems: 'center' },
  engineBtnRiff:   { backgroundColor: '#dcf5dc' },
  engineBtnFlash:  { backgroundColor: '#f5dcdc' },
  engineText:      { fontSize: 12, fontWeight: '600', color: '#999' },
  engineTextRiff:  { color: '#16a34a' },
  engineTextFlash: { color: '#dc2626' },

  // FlashList section wrapper
  flashSection: { marginBottom: 8 },
});
