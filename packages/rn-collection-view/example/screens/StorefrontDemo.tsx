/**
 * Storefront Demo — Compositional Layout vs Nested FlashLists
 *
 * All 8 sections use the same ProductCard component (single item type).
 * No hardcoded widths or heights on cells — Yoga determines all dimensions.
 * Layout engines receive only uniform estimates; MVC corrects after measurement.
 *
 * Sections:
 *   S0 — List H      — Flash Deals         (single-row H carousel)
 *   S1 — Grid 2-col  — Top Picks           (V grid)
 *   S2 — Grid H 2-row— Trending Now        (double-row H carousel)
 *   S3 — List V      — Staff Picks         (full-width V list)
 *   S4 — List H      — Weekend Deals       (single-row H carousel)
 *   S5 — Flow V      — New Arrivals        (V flow, variable-width cards)
 *   S6 — Grid H 2-row— Popular             (double-row H carousel)
 *   S7 — Masonry 2   — Recommended         (V masonry in Riff — grid 2-col in FlashList)
 *
 * Comparison:
 *   Riff:  single CollectionView, unified windowing, 1 recycling pool, ~15 mounted cells
 *   Flash: outer vertical FlashList + nested horizontal FlashLists + manual Views for grid/masonry
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '@riff/components/CollectionView';
import { compositional } from '@riff/layouts/compositional';
import { list } from '@riff/layouts/list';
import { grid } from '@riff/layouts/grid';
import { flow } from '@riff/layouts/flow';
import { masonry } from '@riff/layouts/masonry';
import type { RiffSection } from '@riff/types/protocol';
import { PerfHood } from '../components/PerfHood';

// ── Data model — pure content, no layout dimensions ──────────────────────────

interface ProductItem {
  id: string;
  _type: 'product';
  title: string;
  subtitle: string;
  price: string;
  mrp: string;
  discount: string;
  rating: number;
  ratingCount: string;
  reviews: number;
  color: string;
  badge?: string;
  seller: string;
  delivery: string;
  freebie?: string;
  sponsored: boolean;
}

const COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#f4a261',
  '#264653', '#457b9d', '#6a4c93', '#1982c4',
];

const TITLES = [
  'Wireless Earbuds Pro',
  'Premium Leather Wallet',
  'Smart Watch Ultra',
  'Portable Bluetooth Speaker',
  'USB-C Hub Adapter',
  'Noise Cancelling Headphones',
  'Compact Power Bank',
  'Mechanical Keyboard',
  'Ergonomic Mouse',
  'LED Desk Lamp',
  'Laptop Stand',
  'Webcam HD',
  'Phone Case Premium',
  'Cable Organiser Set',
  'Travel Adapter Universal',
  'Fitness Tracker Band',
  'Wireless Charger Pad',
  'Screen Protector Kit',
  'Memory Card 256GB',
  'Action Camera Mini',
];

const SUBTITLES_SHORT = [
  'Compact and reliable.',
  'Great value.',
  'Bestseller.',
  'Top rated.',
  'Highly recommended.',
];

const SUBTITLES_MEDIUM = [
  'Top-rated by thousands of customers. Excellent build quality and fast shipping.',
  'Sleek modern design with smart features. Loved by professionals alike.',
  'Crafted with premium materials. Lightweight yet strong. Ideal for daily use.',
  'Eco-friendly packaging. Sustainable materials. Zero-waste process.',
  'Versatile and durable. Works in all conditions. Endorsed by experts.',
];

const SUBTITLES_LONG = [
  'Our most loved product. Premium quality and unbeatable durability. Comes with a 2-year warranty, free returns, and dedicated customer support available 24/7.',
  'Handpicked by our editorial team. Award-winning design meets practical everyday use. Available in multiple colors and sizes to suit your needs. Ships worldwide.',
  'Built to last with eco-friendly materials sourced from certified suppliers. Perfect blend of style and function. Recommended by our in-store experts and online reviewers.',
];

const BADGES = ['NEW', 'SALE', 'HOT', 'LIMITED', undefined, undefined, undefined];
const SELLERS = ['SuperStore', 'TechHub', 'RetailKing', 'MegaMart', 'PrimeSeller', 'ValueShop'];
const DELIVERIES = ['Tomorrow', 'Free by Wed', 'Free by Thu', '2-day Express', 'Ships in 24h'];
const FREEBIES = ['Free case included', 'Bonus cable', 'Screen guard free', undefined, undefined, undefined, undefined];

function makeProduct(id: string, index: number): ProductItem {
  // Cycle through short/medium/long subtitles to create genuine height variance
  const subtitlePool = index % 3 === 0 ? SUBTITLES_SHORT
    : index % 3 === 1 ? SUBTITLES_MEDIUM
    : SUBTITLES_LONG;
  const salePrice = 299 + (index * 137) % 2000;
  const mrpPrice = Math.round(salePrice * (1.2 + (index % 5) * 0.1));
  const discountPct = Math.round((1 - salePrice / mrpPrice) * 100);
  return {
    id,
    _type: 'product',
    title: TITLES[index % TITLES.length]!,
    subtitle: subtitlePool[index % subtitlePool.length]!,
    price: `₹${salePrice}`,
    mrp: `₹${mrpPrice}`,
    discount: `${discountPct}% off`,
    rating: 3.5 + (index % 15) * 0.1,
    ratingCount: `${(0.1 + (index * 3) % 50) / 10}k`,
    reviews: 12 + (index * 47) % 5000,
    color: COLORS[index % COLORS.length]!,
    badge: BADGES[index % BADGES.length],
    seller: SELLERS[index % SELLERS.length]!,
    delivery: DELIVERIES[index % DELIVERIES.length]!,
    freebie: FREEBIES[index % FREEBIES.length],
    sponsored: index % 11 === 0,
  };
}

// ── Section data — each section owns its product array ───────────────────────

const S0_DATA = Array.from({ length: 8 },  (_, i) => makeProduct(`s0-${i}`, i));
const S1_DATA = Array.from({ length: 6 },  (_, i) => makeProduct(`s1-${i}`, i + 20));
const S2_DATA = Array.from({ length: 10 }, (_, i) => makeProduct(`s2-${i}`, i + 40));
const S3_DATA = Array.from({ length: 4 },  (_, i) => makeProduct(`s3-${i}`, i + 60));
const S4_DATA = Array.from({ length: 8 },  (_, i) => makeProduct(`s4-${i}`, i + 70));
const S5_DATA = Array.from({ length: 30 }, (_, i) => makeProduct(`s5-${i}`, i + 80));
const S6_DATA = Array.from({ length: 12 }, (_, i) => makeProduct(`s6-${i}`, i + 100));
const S7_DATA = Array.from({ length: 80 }, (_, i) => makeProduct(`s7-${i}`, i + 120));

const ALL_SECTIONS = [
  { key: 'flash-deals',   title: 'Flash Deals',    data: S0_DATA },
  { key: 'top-picks',     title: 'Top Picks',      data: S1_DATA },
  { key: 'trending',      title: 'Trending Now',    data: S2_DATA },
  { key: 'staff-picks',   title: 'Staff Picks',     data: S3_DATA },
  { key: 'weekend-deals', title: 'Weekend Deals',   data: S4_DATA },
  { key: 'new-arrivals',  title: 'New Arrivals',    data: S5_DATA },
  { key: 'popular',       title: 'Popular',          data: S6_DATA },
  { key: 'recommended',   title: 'Recommended',      data: S7_DATA },
];

// ── Section chrome ───────────────────────────────────────────────────────────

const HEADER_H = 44;
const FOOTER_H = 28;

function SectionHeader({ title, count, subtitle }: { title: string; count: number; subtitle: string }) {
  return (
    <View style={S.sectionHeader}>
      <Text style={S.sectionTitle}>{title} ({count})</Text>
      <Text style={S.sectionSubtitle}>{subtitle}</Text>
    </View>
  );
}

function SectionFooter({ label, color }: { label: string; color: string }) {
  return (
    <View style={[S.sectionFooter, { borderTopColor: color + '66', backgroundColor: color + '18' }]}>
      <Text style={[S.sectionFooterText, { color: color + 'cc' }]}>{label}</Text>
    </View>
  );
}

// ── ProductCard — no hardcoded dimensions, content drives size ───────────────

// ~45-50 native view nodes — mirrors a real e-commerce product card
// (image placeholder, badges, wishlist, title, rating stars, price block,
//  delivery, seller, freebie, add-to-cart button)
function ProductCard({ item }: { item: ProductItem }) {
  const stars = Math.floor(item.rating);
  const halfStar = item.rating - stars >= 0.5;
  return (
    <View style={[S.card, { borderColor: item.color + '55' }]}>
      {/* Sponsored tag */}
      {item.sponsored && (
        <View style={S.sponsoredTag}>
          <Text style={S.sponsoredText}>Sponsored</Text>
        </View>
      )}

      {/* Image area + badge + wishlist */}
      <View style={[S.cardImage, { backgroundColor: item.color + '22' }]}>
        <Text style={S.cardImageEmoji}>📦</Text>
        {item.badge && (
          <View style={[S.badge, { backgroundColor: item.color }]}>
            <Text style={S.badgeText}>{item.badge}</Text>
          </View>
        )}
        {/* Wishlist button */}
        <View style={S.wishlistBtn}>
          <Text style={S.wishlistIcon}>♡</Text>
        </View>
      </View>

      <View style={S.cardBody}>
        {/* Title */}
        <Text style={S.cardTitle} numberOfLines={2}>{item.title}</Text>
        <Text style={S.cardSubtitle} numberOfLines={2}>{item.subtitle}</Text>

        {/* Rating row: stars + count */}
        <View style={S.ratingRow}>
          <View style={[S.ratingBadge, { backgroundColor: item.rating >= 4 ? '#2a9d8f' : '#e9c46a' }]}>
            <Text style={S.ratingBadgeText}>{item.rating.toFixed(1)}</Text>
            <Text style={S.ratingBadgeStar}>★</Text>
          </View>
          <Text style={S.ratingCount}>({item.ratingCount})</Text>
          <View style={S.starsRow}>
            {Array.from({ length: 5 }, (_, i) => (
              <Text key={i} style={[S.starIcon, { color: i < stars ? '#facc15' : i === stars && halfStar ? '#facc15' : '#ddd' }]}>
                {i < stars ? '★' : i === stars && halfStar ? '★' : '☆'}
              </Text>
            ))}
          </View>
        </View>

        {/* Price block: sale price, MRP strikethrough, discount */}
        <View style={S.priceBlock}>
          <Text style={[S.cardPrice, { color: item.color }]}>{item.price}</Text>
          <Text style={S.mrpPrice}>{item.mrp}</Text>
          <View style={[S.discountTag, { backgroundColor: item.color + '22' }]}>
            <Text style={[S.discountText, { color: item.color }]}>{item.discount}</Text>
          </View>
        </View>

        {/* Delivery info */}
        <View style={S.deliveryRow}>
          <Text style={S.deliveryIcon}>🚚</Text>
          <Text style={S.deliveryText}>{item.delivery}</Text>
        </View>

        {/* Freebie tag */}
        {item.freebie && (
          <View style={S.freebieRow}>
            <Text style={S.freebieIcon}>🎁</Text>
            <Text style={S.freebieText}>{item.freebie}</Text>
          </View>
        )}

        {/* Seller */}
        <View style={S.sellerRow}>
          <Text style={S.sellerLabel}>Sold by </Text>
          <Text style={S.sellerName}>{item.seller}</Text>
        </View>

        {/* Add to cart button */}
        <View style={[S.addToCartBtn, { borderColor: item.color + '88' }]}>
          <Text style={S.cartIcon}>🛒</Text>
          <Text style={[S.addToCartText, { color: item.color }]}>Add to Cart</Text>
        </View>
      </View>
    </View>
  );
}

// ── Mount tracking ───────────────────────────────────────────────────────────

let totalMounts = 0;
let activeMounts = 0;
let mountGeneration = 0;
let storefrontBlankPct = -1;
let storefrontVelocity = 0;
let storefrontContentH = 0;
let storefrontVpH = 0;
let storefrontPrevOffset = 0;
let storefrontPrevTime = 0;

function resetMounts() {
  totalMounts = 0; activeMounts = 0;
  mountGeneration++;
  storefrontBlankPct = -1; storefrontVelocity = 0;
}

function handleStorefrontScroll(e: any) {
  const offset = e.nativeEvent.contentOffset.y;
  const now = Date.now();
  const dt = now - storefrontPrevTime;
  if (dt > 0 && dt < 300) {
    storefrontVelocity = Math.round(Math.abs(offset - storefrontPrevOffset) / (dt / 1000));
  }
  storefrontPrevOffset = offset;
  storefrontPrevTime = now;
}

function TrackedProductCard({ item }: { item: ProductItem }) {
  useEffect(() => {
    const gen = mountGeneration;
    totalMounts++;
    activeMounts++;
    return () => { if (gen === mountGeneration) activeMounts--; };
  }, []);
  return <ProductCard item={item} />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Riff implementation — single CollectionView, compositional layout
// ═══════════════════════════════════════════════════════════════════════════════

// H sections that need a fixed card width: S0 (List H), S2 (Grid H), S4 (List H), S5 (Flow V), S6 (Grid H)
const H_WIDTH_SECTIONS = new Set([0, 2, 4, 5, 6]);
// Section insets left+right = 10+10 = 20, itemSpacing = 8 between items.
// For 2.25 visible cards: availWidth = 2.25 * cardWidth + 2 * spacing
//   => cardWidth = (vpWidth - 20 - 16) / 2.25 = (vpWidth - 36) / 2.25
function calcHCardWidth(windowWidth: number): number {
  return Math.round((windowWidth - 36) / 2.25);
}

function RiffStorefront({ listRef }: { listRef: React.RefObject<any> }) {
  const { width: windowWidth } = useWindowDimensions();
  const hCardWidth = calcHCardWidth(windowWidth);

  // Alternating section backgrounds for visual grouping
  const SECTION_BG_COLORS = ['#f0f2f5', '#f5f2f0', '#f0f2f5', '#f5f2f0', '#f0f2f5', '#f5f2f0', '#f0f2f5', '#f5f2f0'];

  const layout = useMemo(() => compositional([
    // S0: Flash Deals — single-row H carousel
    { range: 0, layout: list({ estimatedItemHeight: hCardWidth, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', itemSpacing: 8, sectionBackground: true, sectionSpacing: 12 }), horizontal: true },
    // S1: Top Picks — 2-col V grid
    { range: 1, layout: grid({ columns: 2, estimatedItemHeight: 200, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: true, sectionSpacing: 12 }) },
    // S2: Trending Now — 2-row H carousel
    { range: 2, layout: grid({ columns: 2, estimatedItemHeight: 160, columnSpacing: 8, rowSpacing: 8, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: true, sectionSpacing: 12 }), horizontal: true },
    // S3: Staff Picks — full-width V list
    { range: 3, layout: list({ estimatedItemHeight: 140, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', itemSpacing: 10, sectionBackground: true, sectionSpacing: 12 }) },
    // S4: Weekend Deals — single-row H carousel
    { range: 4, layout: list({ estimatedItemHeight: hCardWidth, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', itemSpacing: 8, sectionBackground: true, sectionSpacing: 12 }), horizontal: true },
    // S5: New Arrivals — V flow; card width matches H sections for visual consistency
    { range: 5, layout: flow({ estimatedSizeForItem: (_s: number, _i: number) => ({ width: hCardWidth, height: 180 }), itemSpacing: 8, lineSpacing: 8, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: true, sectionSpacing: 12 }) },
    // S6: Popular — 2-row H carousel
    { range: 6, layout: grid({ columns: 2, estimatedItemHeight: 160, columnSpacing: 8, rowSpacing: 8, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: true, sectionSpacing: 12 }), horizontal: true },
    // S7: Recommended — 2-col V masonry (impossible to nest in FlashList)
    { range: 7, layout: masonry({ columns: 2, estimatedItemHeight: 180, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', sectionBackground: true, sectionSpacing: 12 }) },
  ]), [hCardWidth]);

  const SECTION_META = [
    { subtitle: 'list H — single-row carousel' },
    { subtitle: 'grid V — 2 columns' },
    { subtitle: 'grid H — 2-row carousel' },
    { subtitle: 'list V — full-width' },
    { subtitle: 'list H — single-row carousel' },
    { subtitle: 'flow V — variable-width' },
    { subtitle: 'grid H — 2-row carousel' },
    { subtitle: 'masonry V — 2 columns' },
  ];

  const sections = useMemo<RiffSection<ProductItem>[]>(() =>
    ALL_SECTIONS.map((sec, i) => ({
      key: sec.key,
      data: sec.data,
      header: {
        render: () => <SectionHeader title={sec.title} count={sec.data.length} subtitle={SECTION_META[i]!.subtitle} />,
        height: HEADER_H, sticky: true,
      },
      footer: {
        render: () => <SectionFooter label={`${sec.data.length} items`} color={sec.data[0]!.color} />,
        height: FOOTER_H, sticky: true,
      },
      insets: { top: 8, bottom: 8, left: 10, right: 10 },
    })),
  []);

  const keyExtractor = useCallback((item: ProductItem) => item.id, []);
  const getItemType = useCallback(() => 'product' as const, []);
  const renderItem = useCallback(({ item, sectionIndex }: any) => {
    const card = <TrackedProductCard item={item} />;
    return H_WIDTH_SECTIONS.has(sectionIndex)
      ? <View style={{ width: hCardWidth }}>{card}</View>
      : card;
  }, [hCardWidth]);

  const decorationRenderers = useMemo(() => ({
    sectionBackground: (sectionIndex: number, frame: { x: number; y: number; width: number; height: number }) => (
      <View style={{ position: 'absolute', left: frame.x, top: frame.y, width: frame.width, height: frame.height, backgroundColor: SECTION_BG_COLORS[sectionIndex % SECTION_BG_COLORS.length], borderRadius: 8 }} />
    ),
  }), []);

  return (
    <Riff
      ref={listRef}
      sections={sections}
      layout={layout}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      renderItem={renderItem}
      renderMultiplier={0.25}
      hRenderMultiplier={1.0}
      decorationRenderers={decorationRenderers}
      onBlankArea={({ offsetStart, offsetEnd }) => {
        storefrontBlankPct = storefrontVpH > 0
          ? Math.round((offsetStart + offsetEnd) / storefrontVpH * 100)
          : 0;
      }}
      scrollViewProps={{
        contentInsetAdjustmentBehavior: 'automatic',
        onScroll: handleStorefrontScroll,
        scrollEventThrottle: 100,
        onContentSizeChange: (_: number, h: number) => { storefrontContentH = h; },
      }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FlashList implementation — outer vertical FlashList + nested H FlashLists
// ═══════════════════════════════════════════════════════════════════════════════

// The outer FlashList renders 8 "section cells". Each section cell renders its
// own content: H sections use a nested FlashList horizontal, V grid/masonry
// sections use manual View mapping (no recycling), V list maps items directly.
// This mirrors how real production RN apps build storefront pages.

// Flat data model: headers and footers are separate items so stickyHeaderIndices works.
type FlashFlatItem =
  | { _id: string; _type: 'header'; sectionIndex: number; title: string; subtitle: string; count: number }
  | { _id: string; _type: 'footer'; sectionIndex: number; label: string; color: string }
  | { _id: string; _type: 'content'; sectionIndex: number; data: ProductItem[] };

const FLASH_SUBTITLES = [
  'nested FlashList H',
  'mapped Views — grid',
  'ScrollView H — 2-row grid',
  'mapped Views — list',
  'nested FlashList H',
  'mapped Views — flow wrap',
  'ScrollView H — 2-row grid',
  'mapped Views — grid 2-col (FlashList has no masonry)',
];

const FLASH_FLAT_DATA: FlashFlatItem[] = [];
const FLASH_STICKY_INDICES: number[] = [];

ALL_SECTIONS.forEach((sec, i) => {
  // Header (sticky)
  FLASH_STICKY_INDICES.push(FLASH_FLAT_DATA.length);
  FLASH_FLAT_DATA.push({
    _id: `header-${i}`, _type: 'header', sectionIndex: i,
    title: sec.title, subtitle: FLASH_SUBTITLES[i]!, count: sec.data.length,
  });
  // Content
  FLASH_FLAT_DATA.push({
    _id: `content-${i}`, _type: 'content', sectionIndex: i, data: sec.data,
  });
  // Footer (sticky)
  FLASH_STICKY_INDICES.push(FLASH_FLAT_DATA.length);
  FLASH_FLAT_DATA.push({
    _id: `footer-${i}`, _type: 'footer', sectionIndex: i,
    label: `${sec.data.length} items`, color: sec.data[0]!.color,
  });
});

function FlashHSection({ data }: { data: ProductItem[] }) {
  const renderItem = useCallback(({ item }: { item: ProductItem }) => (
    <View style={S.hCardWrapper}>
      <TrackedProductCard item={item} />
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

function ScrollViewHGridSection({ data, rows = 2 }: { data: ProductItem[]; rows?: number }) {
  // Manual multi-row H grid — what real apps use since FlashList can't numColumns + horizontal.
  const columns: ProductItem[][] = [];
  for (let i = 0; i < data.length; i += rows) {
    columns.push(data.slice(i, i + rows));
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={S.hGridContainer}>
        {columns.map((col, ci) => (
          <View key={ci} style={S.hGridCol}>
            {col.map(item => (
              <View key={item.id} style={S.hGridCell}>
                <TrackedProductCard item={item} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function FlashGridSection({ data, columns }: { data: ProductItem[]; columns: number }) {
  // Manual grid — can't nest FlashList numColumns inside FlashList
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
              <TrackedProductCard item={item} />
            </View>
          ))}
          {row.length < columns && <View style={S.gridCell} />}
        </View>
      ))}
    </View>
  );
}

function FlashFlowSection({ data }: { data: ProductItem[] }) {
  // Manual flow wrap — FlashList can't do flow layout
  return (
    <View style={S.flowWrap}>
      {data.map(item => (
        <View key={item.id} style={S.flowItem}>
          <TrackedProductCard item={item} />
        </View>
      ))}
    </View>
  );
}

function FlashVListSection({ data }: { data: ProductItem[] }) {
  return (
    <View>
      {data.map(item => (
        <View key={item.id} style={S.vListItem}>
          <TrackedProductCard item={item} />
        </View>
      ))}
    </View>
  );
}

function FlashSectionContent({ sectionIndex, data }: { sectionIndex: number; data: ProductItem[] }) {
  return (
    <View style={S.flashSection}>
      {sectionIndex === 0 && <FlashHSection data={data} />}
      {sectionIndex === 1 && <FlashGridSection data={data} columns={2} />}
      {sectionIndex === 2 && <ScrollViewHGridSection data={data} rows={2} />}
      {sectionIndex === 3 && <FlashVListSection data={data} />}
      {sectionIndex === 4 && <FlashHSection data={data} />}
      {sectionIndex === 5 && <FlashFlowSection data={data} />}
      {sectionIndex === 6 && <ScrollViewHGridSection data={data} rows={2} />}
      {sectionIndex === 7 && <FlashGridSection data={data} columns={2} />}
    </View>
  );
}

function FlashStorefront({ listRef }: { listRef: React.RefObject<any> }) {
  const renderItem = useCallback(({ item }: { item: FlashFlatItem }) => {
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
      stickyHeaderIndices={FLASH_STICKY_INDICES}
      onScroll={handleStorefrontScroll}
      scrollEventThrottle={100}
      onContentSizeChange={(_: number, h: number) => { storefrontContentH = h; }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main — engine toggle
// ═══════════════════════════════════════════════════════════════════════════════

type Engine = 'riff' | 'flash';

const TOTAL_ITEMS = 8 + 6 + 10 + 4 + 8 + 30 + 12 + 80; // 158

export default function StorefrontDemo() {
  const [engine, setEngine] = useState<Engine>('riff');
  const listRef = useRef<any>(null);

  // Reset mount counters on engine switch. useLayoutEffect fires synchronously
  // during commit — before children's useEffect mount callbacks. This ensures
  // mountGeneration is bumped before new TrackedProductCard effects capture it,
  // and stale cleanup effects from the old engine are ignored.
  useLayoutEffect(() => { resetMounts(); }, [engine]);

  // Stable getters — PerfHood reads module-level counters on its own tick.
  const getActiveMounts   = useCallback(() => activeMounts, []);
  const getTotalMounts    = useCallback(() => totalMounts, []);
  const getBlankAreaPct   = useCallback(() => storefrontBlankPct, []);
  const getScrollVelocity = useCallback(() => storefrontVelocity, []);
  const getContentHeight  = useCallback(() => storefrontContentH, []);

  return (
    <SafeAreaView style={S.root}>
      <View style={S.engineBar}>
        <Pressable
          style={[S.engineBtn, engine === 'riff' && S.engineBtnRiff]}
          onPress={() => setEngine('riff')}
        >
          <Text style={[S.engineText, engine === 'riff' && S.engineTextRiff]}>Riff</Text>
        </Pressable>
        <Pressable
          style={[S.engineBtn, engine === 'flash' && S.engineBtnFlash]}
          onPress={() => setEngine('flash')}
        >
          <Text style={[S.engineText, engine === 'flash' && S.engineTextFlash]}>FlashList</Text>
        </Pressable>
      </View>

      <View style={S.content} onLayout={(e) => { storefrontVpH = e.nativeEvent.layout.height; }}>
        {engine === 'riff'
          ? <RiffStorefront listRef={listRef} />
          : <FlashStorefront listRef={listRef} />}
      </View>

      <PerfHood
        getActiveMounts={getActiveMounts}
        getTotalMounts={getTotalMounts}
        getScrollVelocity={getScrollVelocity}
        getBlankAreaPct={getBlankAreaPct}
        scrollRef={listRef}
        engine={engine === 'riff' ? 'riff' : 'flash'}
        tab="storefront"
        itemCount={TOTAL_ITEMS}
        itemHeight={40}
        getContentHeight={getContentHeight}
      />
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
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

  // Section chrome
  sectionHeader: {
    backgroundColor: '#ffffffee',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd',
    justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10,
  },
  sectionTitle:      { color: '#111', fontSize: 14, fontWeight: '700' },
  sectionSubtitle:   { color: '#888', fontSize: 11, marginTop: 1 },
  sectionFooter:     { borderTopWidth: 1, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 6 },
  sectionFooterText: { fontSize: 11, fontWeight: '600' },

  // ProductCard (~45-50 native nodes)
  card: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1,
    overflow: 'hidden',
  },
  sponsoredTag:  { position: 'absolute', top: 0, left: 0, zIndex: 2, backgroundColor: '#e5e5e5', paddingHorizontal: 5, paddingVertical: 1, borderBottomRightRadius: 6 },
  sponsoredText: { color: '#666', fontSize: 8, fontWeight: '600' },
  cardImage:     { aspectRatio: 1.3, alignItems: 'center', justifyContent: 'center' },
  cardImageEmoji: { fontSize: 32 },
  badge: {
    position: 'absolute', top: 8, left: 8, zIndex: 1,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  badgeText:     { color: '#fff', fontSize: 9, fontWeight: '800' },
  wishlistBtn:   { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.08)', alignItems: 'center', justifyContent: 'center' },
  wishlistIcon:  { color: '#333', fontSize: 16 },
  cardBody:      { padding: 10, gap: 4 },
  cardTitle:     { color: '#111', fontSize: 13, fontWeight: '600' },
  cardSubtitle:  { color: '#666', fontSize: 11, lineHeight: 15 },
  // Rating row
  ratingRow:      { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ratingBadge:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, gap: 1 },
  ratingBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  ratingBadgeStar: { color: '#fff', fontSize: 8 },
  ratingCount:    { color: '#888', fontSize: 10 },
  starsRow:       { flexDirection: 'row', marginLeft: 2 },
  starIcon:       { fontSize: 10 },
  // Price block
  priceBlock:    { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  cardPrice:     { fontSize: 15, fontWeight: '700' },
  mrpPrice:      { fontSize: 11, color: '#999', textDecorationLine: 'line-through' },
  discountTag:   { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
  discountText:  { fontSize: 10, fontWeight: '700' },
  // Delivery
  deliveryRow:   { flexDirection: 'row', alignItems: 'center', gap: 4 },
  deliveryIcon:  { fontSize: 12 },
  deliveryText:  { color: '#16a34a', fontSize: 11, fontWeight: '500' },
  // Freebie
  freebieRow:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  freebieIcon:   { fontSize: 11 },
  freebieText:   { color: '#b8860b', fontSize: 10 },
  // Seller
  sellerRow:     { flexDirection: 'row', alignItems: 'center' },
  sellerLabel:   { color: '#888', fontSize: 10 },
  sellerName:    { color: '#555', fontSize: 10, fontWeight: '600' },
  // Add to cart
  addToCartBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6, borderRadius: 6, borderWidth: 1, marginTop: 2 },
  cartIcon:      { fontSize: 12 },
  addToCartText: { fontSize: 11, fontWeight: '700' },

  // FlashList section wrapper
  flashSection: { marginBottom: 8 },

  // H-section card wrapper (fixed width for horizontal FlashList — matches Riff's estimate)
  hCardWrapper: { width: 180, padding: 4 },

  // Manual grid
  gridRow:  { flexDirection: 'row', gap: 10, paddingHorizontal: 10, marginBottom: 10 },
  gridCell: { flex: 1 },

  // Manual flow wrap
  flowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingVertical: 4 },
  flowItem: {},

  // V list items
  vListItem: { paddingHorizontal: 10, marginBottom: 10 },

  // ScrollView H-grid (multi-row horizontal carousel)
  hGridContainer: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 4 },
  hGridCol:       { width: 180, gap: 8 },
  hGridCell:      { height: 160 },
});
