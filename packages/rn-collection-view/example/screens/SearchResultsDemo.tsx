/**
 * Search Results Demo — Compositional Layout vs Nested FlashLists
 *
 * Simulates a Flipkart/Amazon search results page: mostly 2-col vertical grids
 * of product cards with banner carousels and horizontal product lists interspersed.
 *
 * Sections (9):
 *   S0 — Grid 2-col   — Search Results       (V grid, sticky search+filter header)
 *   S1 — List H       — Sponsored            (H banner carousel)
 *   S2 — Grid 2-col   — More Results         (V grid)
 *   S3 — List H       — People also searched (H product list)
 *   S4 — Grid 2-col   — Keep exploring       (V grid)
 *   S5 — List H       — Sponsored            (H banner carousel)
 *   S6 — Grid 2-col   — Based on your history(V grid)
 *   S7 — List H       — Customers also viewed(H product list)
 *   S8 — Grid 2-col   — More to explore      (V grid)
 *
 * Total: 150 grid products + 16 H-list products + 7 banners = 173 items
 *
 * Comparison:
 *   Riff:  single CollectionView, compositional layout, unified windowing
 *   Flash: outer vertical FlashList + nested H FlashLists + manual grid Views
 */
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '@riff/components/CollectionView';
import { compositional } from '@riff/layouts/compositional';
import { list } from '@riff/layouts/list';
import { grid } from '@riff/layouts/grid';
import type { RiffSection } from '@riff/types/protocol';
import { PerfHood } from '../components/PerfHood';
import {
  ProductItem,
  BannerItem,
  makeProduct,
  makeBanner,
  TrackedProductCard,
  BannerCard,
  SearchBar,
  FilterBar,
  SectionHeader,
  SectionFooter,
  HEADER_H,
  FOOTER_H,
  createMountTracker,
  S as BS,
} from './benchmarkShared';

// ── Section data ────────────────────────────────────────────────────────────

const GRID_0   = Array.from({ length: 20 }, (_, i) => makeProduct(`sr-g0-${i}`, i));
const BANNER_1 = Array.from({ length: 4 },  (_, i) => makeBanner(`sr-b1-${i}`, i));
const GRID_2   = Array.from({ length: 25 }, (_, i) => makeProduct(`sr-g2-${i}`, i + 20));
const HLIST_3  = Array.from({ length: 8 },  (_, i) => makeProduct(`sr-h3-${i}`, i + 50));
const GRID_4   = Array.from({ length: 25 }, (_, i) => makeProduct(`sr-g4-${i}`, i + 60));
const BANNER_5 = Array.from({ length: 3 },  (_, i) => makeBanner(`sr-b5-${i}`, i + 10));
const GRID_6   = Array.from({ length: 25 }, (_, i) => makeProduct(`sr-g6-${i}`, i + 90));
const HLIST_7  = Array.from({ length: 8 },  (_, i) => makeProduct(`sr-h7-${i}`, i + 120));
const GRID_8   = Array.from({ length: 55 }, (_, i) => makeProduct(`sr-g8-${i}`, i + 130));

const FILTERS = ['Sort', 'Price', 'Brand', 'Rating', 'Delivery'];

// ── Mount tracking ──────────────────────────────────────────────────────────

const tracker = createMountTracker();

// ═══════════════════════════════════════════════════════════════════════════════
// Riff implementation — single CollectionView, compositional layout
// ═══════════════════════════════════════════════════════════════════════════════

function RiffSearchResults({ listRef }: { listRef: React.RefObject<any> }) {
  const layout = useMemo(() => compositional([
    { range: 0, layout: grid({ columns: 2, estimatedItemHeight: 200, columnSpacing: 10, rowSpacing: 10, headerHeight: 80, footerHeight: FOOTER_H, sectionSpacing: 8 }) },
    { range: 1, layout: list({ estimatedItemHeight: 280, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 8, estimatedCrossAxisHeight: 180 }), horizontal: true },
    { range: 2, layout: grid({ columns: 2, estimatedItemHeight: 200, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, sectionSpacing: 8 }) },
    { range: 3, layout: list({ estimatedItemHeight: 180, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 8, estimatedCrossAxisHeight: 350 }), horizontal: true },
    { range: 4, layout: grid({ columns: 2, estimatedItemHeight: 200, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, sectionSpacing: 8 }) },
    { range: 5, layout: list({ estimatedItemHeight: 280, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 8, estimatedCrossAxisHeight: 180 }), horizontal: true },
    { range: 6, layout: grid({ columns: 2, estimatedItemHeight: 200, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, sectionSpacing: 8 }) },
    { range: 7, layout: list({ estimatedItemHeight: 180, headerHeight: HEADER_H, itemSpacing: 8, sectionSpacing: 8, estimatedCrossAxisHeight: 350 }), horizontal: true },
    { range: 8, layout: grid({ columns: 2, estimatedItemHeight: 200, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, sectionSpacing: 8 }) },
  ]), []);

  const sections = useMemo<RiffSection<ProductItem | BannerItem>[]>(() => [
    {
      key: 'search-grid-0',
      data: GRID_0,
      header: {
        render: () => (
          <View>
            <SearchBar placeholder="Wireless earbuds" />
            <FilterBar filters={FILTERS} />
          </View>
        ),
        height: 80,
      },
      footer: { render: () => <SectionFooter label={`${GRID_0.length} items`} color={GRID_0[0]!.color} />, height: FOOTER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'sponsored-banners-1',
      data: BANNER_1,
      header: { render: () => <SectionHeader title="Sponsored" count={BANNER_1.length} subtitle="banner carousel" />, height: HEADER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'search-grid-2',
      data: GRID_2,
      header: { render: () => <SectionHeader title="More Results" count={GRID_2.length} subtitle="grid 2-col" />, height: HEADER_H },
      footer: { render: () => <SectionFooter label={`${GRID_2.length} items`} color={GRID_2[0]!.color} />, height: FOOTER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'also-searched-3',
      data: HLIST_3,
      header: { render: () => <SectionHeader title="People also searched" count={HLIST_3.length} subtitle="H product list" />, height: HEADER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'search-grid-4',
      data: GRID_4,
      header: { render: () => <SectionHeader title="Keep exploring" count={GRID_4.length} subtitle="grid 2-col" />, height: HEADER_H },
      footer: { render: () => <SectionFooter label={`${GRID_4.length} items`} color={GRID_4[0]!.color} />, height: FOOTER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'sponsored-banners-5',
      data: BANNER_5,
      header: { render: () => <SectionHeader title="Sponsored" count={BANNER_5.length} subtitle="banner carousel" />, height: HEADER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'search-grid-6',
      data: GRID_6,
      header: { render: () => <SectionHeader title="Based on your history" count={GRID_6.length} subtitle="grid 2-col" />, height: HEADER_H },
      footer: { render: () => <SectionFooter label={`${GRID_6.length} items`} color={GRID_6[0]!.color} />, height: FOOTER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'also-viewed-7',
      data: HLIST_7,
      header: { render: () => <SectionHeader title="Customers also viewed" count={HLIST_7.length} subtitle="H product list" />, height: HEADER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
    {
      key: 'search-grid-8',
      data: GRID_8,
      header: { render: () => <SectionHeader title="More to explore" count={GRID_8.length} subtitle="grid 2-col" />, height: HEADER_H },
      footer: { render: () => <SectionFooter label={`${GRID_8.length} items`} color={GRID_8[0]!.color} />, height: FOOTER_H },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    },
  ], []);

  const keyExtractor = useCallback((item: ProductItem | BannerItem) => item.id, []);
  const getItemType = useCallback((item: ProductItem | BannerItem) => item._type, []);
  const renderItem = useCallback(({ item }: { item: ProductItem | BannerItem }) => {
    if (item._type === 'banner') return <BannerCard item={item} />;
    return <TrackedProductCard item={item} onMount={tracker.onMount} />;
  }, []);

  return (
    <Riff
      ref={listRef}
      sections={sections}
      layout={layout}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      renderItem={renderItem}
      renderMultiplier={0.25}
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
// FlashList implementation — outer vertical FlashList + nested H FlashLists
// ═══════════════════════════════════════════════════════════════════════════════

// Flat data model: headers and footers are separate items so stickyHeaderIndices works.
type FlashFlatItem =
  | { _id: string; _type: 'header'; sectionIndex: number; title: string; subtitle: string; count: number }
  | { _id: string; _type: 'searchHeader'; sectionIndex: number }
  | { _id: string; _type: 'footer'; sectionIndex: number; label: string; color: string }
  | { _id: string; _type: 'gridContent'; sectionIndex: number; data: ProductItem[] }
  | { _id: string; _type: 'hProductContent'; sectionIndex: number; data: ProductItem[] }
  | { _id: string; _type: 'hBannerContent'; sectionIndex: number; data: BannerItem[] };

const FLASH_FLAT_DATA: FlashFlatItem[] = [];

// S0: search header + grid content + footer
FLASH_FLAT_DATA.push({ _id: 'search-header-0', _type: 'searchHeader', sectionIndex: 0 });
FLASH_FLAT_DATA.push({ _id: 'content-0', _type: 'gridContent', sectionIndex: 0, data: GRID_0 });
FLASH_FLAT_DATA.push({ _id: 'footer-0', _type: 'footer', sectionIndex: 0, label: `${GRID_0.length} items`, color: GRID_0[0]!.color });

// S1: header + H banner content
FLASH_FLAT_DATA.push({ _id: 'header-1', _type: 'header', sectionIndex: 1, title: 'Sponsored', subtitle: 'nested FlashList H', count: BANNER_1.length });
FLASH_FLAT_DATA.push({ _id: 'content-1', _type: 'hBannerContent', sectionIndex: 1, data: BANNER_1 });

// S2: header + grid content + footer
FLASH_FLAT_DATA.push({ _id: 'header-2', _type: 'header', sectionIndex: 2, title: 'More Results', subtitle: 'mapped Views — grid', count: GRID_2.length });
FLASH_FLAT_DATA.push({ _id: 'content-2', _type: 'gridContent', sectionIndex: 2, data: GRID_2 });
FLASH_FLAT_DATA.push({ _id: 'footer-2', _type: 'footer', sectionIndex: 2, label: `${GRID_2.length} items`, color: GRID_2[0]!.color });

// S3: header + H product content
FLASH_FLAT_DATA.push({ _id: 'header-3', _type: 'header', sectionIndex: 3, title: 'People also searched', subtitle: 'nested FlashList H', count: HLIST_3.length });
FLASH_FLAT_DATA.push({ _id: 'content-3', _type: 'hProductContent', sectionIndex: 3, data: HLIST_3 });

// S4: header + grid content + footer
FLASH_FLAT_DATA.push({ _id: 'header-4', _type: 'header', sectionIndex: 4, title: 'Keep exploring', subtitle: 'mapped Views — grid', count: GRID_4.length });
FLASH_FLAT_DATA.push({ _id: 'content-4', _type: 'gridContent', sectionIndex: 4, data: GRID_4 });
FLASH_FLAT_DATA.push({ _id: 'footer-4', _type: 'footer', sectionIndex: 4, label: `${GRID_4.length} items`, color: GRID_4[0]!.color });

// S5: header + H banner content
FLASH_FLAT_DATA.push({ _id: 'header-5', _type: 'header', sectionIndex: 5, title: 'Sponsored', subtitle: 'nested FlashList H', count: BANNER_5.length });
FLASH_FLAT_DATA.push({ _id: 'content-5', _type: 'hBannerContent', sectionIndex: 5, data: BANNER_5 });

// S6: header + grid content + footer
FLASH_FLAT_DATA.push({ _id: 'header-6', _type: 'header', sectionIndex: 6, title: 'Based on your history', subtitle: 'mapped Views — grid', count: GRID_6.length });
FLASH_FLAT_DATA.push({ _id: 'content-6', _type: 'gridContent', sectionIndex: 6, data: GRID_6 });
FLASH_FLAT_DATA.push({ _id: 'footer-6', _type: 'footer', sectionIndex: 6, label: `${GRID_6.length} items`, color: GRID_6[0]!.color });

// S7: header + H product content
FLASH_FLAT_DATA.push({ _id: 'header-7', _type: 'header', sectionIndex: 7, title: 'Customers also viewed', subtitle: 'nested FlashList H', count: HLIST_7.length });
FLASH_FLAT_DATA.push({ _id: 'content-7', _type: 'hProductContent', sectionIndex: 7, data: HLIST_7 });

// S8: header + grid content + footer
FLASH_FLAT_DATA.push({ _id: 'header-8', _type: 'header', sectionIndex: 8, title: 'More to explore', subtitle: 'mapped Views — grid', count: GRID_8.length });
FLASH_FLAT_DATA.push({ _id: 'content-8', _type: 'gridContent', sectionIndex: 8, data: GRID_8 });
FLASH_FLAT_DATA.push({ _id: 'footer-8', _type: 'footer', sectionIndex: 8, label: `${GRID_8.length} items`, color: GRID_8[0]!.color });

// ── FlashList helper components ─────────────────────────────────────────────

function FlashHProductSection({ data }: { data: ProductItem[] }) {
  return (
    <FlashList
      horizontal
      data={data}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <View style={BS.hCardWrapper}>
          <TrackedProductCard item={item} onMount={tracker.onMount} />
        </View>
      )}
      estimatedItemSize={180}
      showsHorizontalScrollIndicator={false}
    />
  );
}

function FlashHBannerSection({ data }: { data: BannerItem[] }) {
  return (
    <FlashList
      horizontal
      data={data}
      keyExtractor={item => item.id}
      renderItem={({ item }) => (
        <View style={BS.bannerWrapper}>
          <BannerCard item={item} />
        </View>
      )}
      estimatedItemSize={280}
      showsHorizontalScrollIndicator={false}
    />
  );
}

function FlashGridSection({ data, columns }: { data: ProductItem[]; columns: number }) {
  const rows: ProductItem[][] = [];
  for (let i = 0; i < data.length; i += columns) rows.push(data.slice(i, i + columns));
  return (
    <View>
      {rows.map((row, ri) => (
        <View key={ri} style={BS.gridRow}>
          {row.map(item => (
            <View key={item.id} style={BS.gridCell}>
              <TrackedProductCard item={item} onMount={tracker.onMount} />
            </View>
          ))}
          {row.length < columns && <View style={BS.gridCell} />}
        </View>
      ))}
    </View>
  );
}

function FlashSearchResults({ listRef }: { listRef: React.RefObject<any> }) {
  const renderItem = useCallback(({ item }: { item: FlashFlatItem }) => {
    switch (item._type) {
      case 'searchHeader':
        return (
          <View>
            <SearchBar placeholder="Wireless earbuds" />
            <FilterBar filters={FILTERS} />
          </View>
        );
      case 'header':
        return <SectionHeader title={item.title} count={item.count} subtitle={item.subtitle} />;
      case 'footer':
        return <SectionFooter label={item.label} color={item.color} />;
      case 'gridContent':
        return (
          <View style={LS.flashSection}>
            <FlashGridSection data={item.data} columns={2} />
          </View>
        );
      case 'hProductContent':
        return (
          <View style={LS.flashSection}>
            <FlashHProductSection data={item.data} />
          </View>
        );
      case 'hBannerContent':
        return (
          <View style={LS.flashSection}>
            <FlashHBannerSection data={item.data} />
          </View>
        );
      default:
        return null;
    }
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

const TOTAL_ITEMS = 20 + 4 + 25 + 8 + 25 + 3 + 25 + 8 + 55; // 173

export default function SearchResultsDemo() {
  const [engine, setEngine] = useState<Engine>('riff');
  const listRef = useRef<any>(null);

  // Reset mount counters on engine switch
  useLayoutEffect(() => { tracker.reset(); }, [engine]);

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
          ? <RiffSearchResults listRef={listRef} />
          : <FlashSearchResults listRef={listRef} />}
      </View>

      <PerfHood
        getActiveMounts={tracker.getActive}
        getTotalMounts={tracker.getTotal}
        getScrollVelocity={tracker.getVelocity}
        getBlankAreaPct={tracker.getBlank}
        scrollRef={listRef}
        engine={engine === 'riff' ? 'riff' : 'flash'}
        tab="search-results"
        itemCount={TOTAL_ITEMS}
        itemHeight={40}
        getContentHeight={tracker.getContentH}
      />
    </SafeAreaView>
  );
}

// ── Local styles ────────────────────────────────────────────────────────────

const LS = StyleSheet.create({
  root:           { flex: 1, backgroundColor: '#f5f5f5' },
  content:        { flex: 1 },
  engineBar:      { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  engineBtn:      { flex: 1, paddingVertical: 6, borderRadius: 6, backgroundColor: '#e5e5e5', alignItems: 'center' },
  engineBtnRiff:  { backgroundColor: '#dcf5dc' },
  engineBtnFlash: { backgroundColor: '#f5dcdc' },
  engineText:     { fontSize: 12, fontWeight: '600', color: '#999' },
  engineTextRiff: { color: '#16a34a' },
  engineTextFlash: { color: '#dc2626' },
  flashSection:   { marginBottom: 8 },
});
