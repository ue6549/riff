/**
 * Shared components and data generators for benchmark screens.
 *
 * ProductCard: ~45-50 native view nodes — mirrors a real e-commerce product card.
 * All benchmark screens import from here so card complexity is identical.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

// ── Data model ───────────────────────────────────────────────────────────────

export interface ProductItem {
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

export interface BannerItem {
  id: string;
  _type: 'banner';
  title: string;
  subtitle: string;
  cta: string;
  color: string;
}

export interface CategoryItem {
  id: string;
  _type: 'category';
  label: string;
  emoji: string;
  color: string;
}

const COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#f4a261',
  '#264653', '#457b9d', '#6a4c93', '#1982c4',
];

const TITLES = [
  'Wireless Earbuds Pro', 'Premium Leather Wallet', 'Smart Watch Ultra',
  'Portable Bluetooth Speaker', 'USB-C Hub Adapter', 'Noise Cancelling Headphones',
  'Compact Power Bank', 'Mechanical Keyboard', 'Ergonomic Mouse', 'LED Desk Lamp',
  'Laptop Stand', 'Webcam HD', 'Phone Case Premium', 'Cable Organiser Set',
  'Travel Adapter Universal', 'Fitness Tracker Band', 'Wireless Charger Pad',
  'Screen Protector Kit', 'Memory Card 256GB', 'Action Camera Mini',
];

const SUBTITLES_SHORT = ['Compact and reliable.', 'Great value.', 'Bestseller.', 'Top rated.', 'Highly recommended.'];
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

export function makeProduct(id: string, index: number): ProductItem {
  const subtitlePool = index % 3 === 0 ? SUBTITLES_SHORT
    : index % 3 === 1 ? SUBTITLES_MEDIUM : SUBTITLES_LONG;
  const salePrice = 299 + (index * 137) % 2000;
  const mrpPrice = Math.round(salePrice * (1.2 + (index % 5) * 0.1));
  const discountPct = Math.round((1 - salePrice / mrpPrice) * 100);
  return {
    id, _type: 'product',
    title: TITLES[index % TITLES.length]!,
    subtitle: subtitlePool[index % subtitlePool.length]!,
    price: `₹${salePrice}`, mrp: `₹${mrpPrice}`, discount: `${discountPct}% off`,
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

export function makeBanner(id: string, index: number): BannerItem {
  const promos = [
    { title: 'Summer Sale', subtitle: 'Up to 70% off on electronics', cta: 'Shop Now' },
    { title: 'New Arrivals', subtitle: 'Fresh drops every week', cta: 'Explore' },
    { title: 'Flash Deal', subtitle: 'Ends in 2 hours — don\'t miss out', cta: 'Grab It' },
    { title: 'Top Brands', subtitle: 'Premium products at best prices', cta: 'Browse' },
    { title: 'Free Shipping', subtitle: 'On orders above ₹499', cta: 'Start Shopping' },
    { title: 'Clearance', subtitle: 'Last chance — stock running low', cta: 'View All' },
  ];
  const p = promos[index % promos.length]!;
  return { id, _type: 'banner', title: p.title, subtitle: p.subtitle, cta: p.cta, color: COLORS[index % COLORS.length]! };
}

export function makeCategory(id: string, index: number): CategoryItem {
  const cats = [
    { label: 'Electronics', emoji: '📱' }, { label: 'Fashion', emoji: '👕' },
    { label: 'Home', emoji: '🏠' }, { label: 'Sports', emoji: '⚽' },
    { label: 'Books', emoji: '📚' }, { label: 'Toys', emoji: '🧸' },
    { label: 'Beauty', emoji: '💄' }, { label: 'Grocery', emoji: '🛒' },
    { label: 'Auto', emoji: '🚗' }, { label: 'Garden', emoji: '🌱' },
    { label: 'Kitchen', emoji: '🍳' }, { label: 'Travel', emoji: '✈️' },
  ];
  const c = cats[index % cats.length]!;
  return { id, _type: 'category', label: c.label, emoji: c.emoji, color: COLORS[index % COLORS.length]! };
}

// ── Section chrome ───────────────────────────────────────────────────────────

export const HEADER_H = 44;
export const FOOTER_H = 28;

export function SectionHeader({ title, count, subtitle }: { title: string; count: number; subtitle: string }) {
  return (
    <View style={S.sectionHeader}>
      <Text style={S.sectionTitle}>{title} ({count})</Text>
      <Text style={S.sectionSubtitle}>{subtitle}</Text>
    </View>
  );
}

export function SectionFooter({ label, color }: { label: string; color: string }) {
  return (
    <View style={[S.sectionFooter, { borderTopColor: color + '66', backgroundColor: color + '18' }]}>
      <Text style={[S.sectionFooterText, { color: color + 'cc' }]}>{label}</Text>
    </View>
  );
}

// ── Mount tracking factory ───────────────────────────────────────────────────

export function createMountTracker() {
  let totalMounts = 0;
  let activeMounts = 0;
  let generation = 0;
  let blankPct = -1;
  let velocity = 0;
  let contentH = 0;
  let vpH = 0;
  let prevOffset = 0;
  let prevTime = 0;

  return {
    getActive: () => activeMounts,
    getTotal: () => totalMounts,
    getBlank: () => blankPct,
    getVelocity: () => velocity,
    getContentH: () => contentH,
    setContentH: (h: number) => { contentH = h; },
    setBlank: (b: number) => { blankPct = b; },
    getVpH: () => vpH,
    setVpH: (h: number) => { vpH = h; },
    reset: () => { totalMounts = 0; activeMounts = 0; generation++; blankPct = -1; velocity = 0; },
    onMount: () => {
      const gen = generation;
      totalMounts++;
      activeMounts++;
      return () => { if (gen === generation) activeMounts--; };
    },
    onScroll: (e: any) => {
      const offset = e.nativeEvent.contentOffset.y;
      const now = Date.now();
      const dt = now - prevTime;
      if (dt > 0 && dt < 300) velocity = Math.round(Math.abs(offset - prevOffset) / (dt / 1000));
      prevOffset = offset;
      prevTime = now;
    },
  };
}

// ── ProductCard — ~45-50 native nodes, content-driven size ───────────────────

export function ProductCard({ item }: { item: ProductItem }) {
  const stars = Math.floor(item.rating);
  const halfStar = item.rating - stars >= 0.5;
  return (
    <View style={[S.card, { borderColor: item.color + '55' }]}>
      {item.sponsored && (
        <View style={S.sponsoredTag}><Text style={S.sponsoredText}>Sponsored</Text></View>
      )}
      <View style={[S.cardImage, { backgroundColor: item.color + '22' }]}>
        <Text style={S.cardImageEmoji}>📦</Text>
        {item.badge && (
          <View style={[S.badge, { backgroundColor: item.color }]}>
            <Text style={S.badgeText}>{item.badge}</Text>
          </View>
        )}
        <View style={S.wishlistBtn}><Text style={S.wishlistIcon}>♡</Text></View>
      </View>
      <View style={S.cardBody}>
        <Text style={S.cardTitle} numberOfLines={2}>{item.title}</Text>
        <Text style={S.cardSubtitle} numberOfLines={2}>{item.subtitle}</Text>
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
        <View style={S.priceBlock}>
          <Text style={[S.cardPrice, { color: item.color }]}>{item.price}</Text>
          <Text style={S.mrpPrice}>{item.mrp}</Text>
          <View style={[S.discountTag, { backgroundColor: item.color + '22' }]}>
            <Text style={[S.discountText, { color: item.color }]}>{item.discount}</Text>
          </View>
        </View>
        <View style={S.deliveryRow}>
          <Text style={S.deliveryIcon}>🚚</Text>
          <Text style={S.deliveryText}>{item.delivery}</Text>
        </View>
        {item.freebie && (
          <View style={S.freebieRow}>
            <Text style={S.freebieIcon}>🎁</Text>
            <Text style={S.freebieText}>{item.freebie}</Text>
          </View>
        )}
        <View style={S.sellerRow}>
          <Text style={S.sellerLabel}>Sold by </Text>
          <Text style={S.sellerName}>{item.seller}</Text>
        </View>
        <View style={[S.addToCartBtn, { borderColor: item.color + '88' }]}>
          <Text style={S.cartIcon}>🛒</Text>
          <Text style={[S.addToCartText, { color: item.color }]}>Add to Cart</Text>
        </View>
      </View>
    </View>
  );
}

/** Wraps ProductCard with mount tracking. Each screen passes its own tracker. */
export function TrackedProductCard({ item, onMount }: { item: ProductItem; onMount: () => () => void }) {
  useEffect(() => onMount(), []);
  return <ProductCard item={item} />;
}

// ── BannerCard ───────────────────────────────────────────────────────────────

export function BannerCard({ item }: { item: BannerItem }) {
  return (
    <View style={[S.bannerCard, { backgroundColor: item.color + '22', borderColor: item.color + '44' }]}>
      <Text style={[S.bannerTitle, { color: item.color }]}>{item.title}</Text>
      <Text style={S.bannerSubtitle}>{item.subtitle}</Text>
      <View style={[S.bannerCta, { backgroundColor: item.color }]}>
        <Text style={S.bannerCtaText}>{item.cta}</Text>
      </View>
    </View>
  );
}

// ── CategoryChip ─────────────────────────────────────────────────────────────

export function CategoryChip({ item }: { item: CategoryItem }) {
  return (
    <View style={S.categoryChip}>
      <View style={[S.categoryCircle, { backgroundColor: item.color + '22' }]}>
        <Text style={S.categoryEmoji}>{item.emoji}</Text>
      </View>
      <Text style={S.categoryLabel}>{item.label}</Text>
    </View>
  );
}

// ── SearchBar ────────────────────────────────────────────────────────────────

export function SearchBar({ placeholder }: { placeholder?: string }) {
  return (
    <View style={S.searchBar}>
      <Text style={S.searchIcon}>🔍</Text>
      <Text style={S.searchPlaceholder}>{placeholder ?? 'Search products, brands...'}</Text>
    </View>
  );
}

// ── FilterBar ────────────────────────────────────────────────────────────────

export function FilterBar({ filters }: { filters: string[] }) {
  return (
    <View style={S.filterBar}>
      {filters.map(f => (
        <View key={f} style={S.filterChip}>
          <Text style={S.filterText}>{f}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

export const S = StyleSheet.create({
  // Section chrome
  sectionHeader: {
    backgroundColor: '#ffffffee', borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd', justifyContent: 'center',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  sectionTitle:      { color: '#111', fontSize: 14, fontWeight: '700' },
  sectionSubtitle:   { color: '#888', fontSize: 11, marginTop: 1 },
  sectionFooter:     { borderTopWidth: 1, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 6 },
  sectionFooterText: { fontSize: 11, fontWeight: '600' },

  // ProductCard
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  sponsoredTag:  { position: 'absolute', top: 0, left: 0, zIndex: 2, backgroundColor: '#e5e5e5', paddingHorizontal: 5, paddingVertical: 1, borderBottomRightRadius: 6 },
  sponsoredText: { color: '#666', fontSize: 8, fontWeight: '600' },
  cardImage:     { aspectRatio: 1.3, alignItems: 'center', justifyContent: 'center' },
  cardImageEmoji: { fontSize: 32 },
  badge:         { position: 'absolute', top: 8, left: 8, zIndex: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  badgeText:     { color: '#fff', fontSize: 9, fontWeight: '800' },
  wishlistBtn:   { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.08)', alignItems: 'center', justifyContent: 'center' },
  wishlistIcon:  { color: '#333', fontSize: 16 },
  cardBody:      { padding: 10, gap: 4 },
  cardTitle:     { color: '#111', fontSize: 13, fontWeight: '600' },
  cardSubtitle:  { color: '#666', fontSize: 11, lineHeight: 15 },
  ratingRow:      { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ratingBadge:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, gap: 1 },
  ratingBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  ratingBadgeStar: { color: '#fff', fontSize: 8 },
  ratingCount:    { color: '#888', fontSize: 10 },
  starsRow:       { flexDirection: 'row', marginLeft: 2 },
  starIcon:       { fontSize: 10 },
  priceBlock:    { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  cardPrice:     { fontSize: 15, fontWeight: '700' },
  mrpPrice:      { fontSize: 11, color: '#999', textDecorationLine: 'line-through' },
  discountTag:   { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
  discountText:  { fontSize: 10, fontWeight: '700' },
  deliveryRow:   { flexDirection: 'row', alignItems: 'center', gap: 4 },
  deliveryIcon:  { fontSize: 12 },
  deliveryText:  { color: '#16a34a', fontSize: 11, fontWeight: '500' },
  freebieRow:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  freebieIcon:   { fontSize: 11 },
  freebieText:   { color: '#b8860b', fontSize: 10 },
  sellerRow:     { flexDirection: 'row', alignItems: 'center' },
  sellerLabel:   { color: '#888', fontSize: 10 },
  sellerName:    { color: '#555', fontSize: 10, fontWeight: '600' },
  addToCartBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6, borderRadius: 6, borderWidth: 1, marginTop: 2 },
  cartIcon:      { fontSize: 12 },
  addToCartText: { fontSize: 11, fontWeight: '700' },

  // BannerCard
  bannerCard:    { borderRadius: 12, borderWidth: 1, padding: 20, minHeight: 140, justifyContent: 'center' },
  bannerTitle:   { fontSize: 20, fontWeight: '800' },
  bannerSubtitle: { color: '#666', fontSize: 13, marginTop: 4, marginBottom: 12 },
  bannerCta:     { alignSelf: 'flex-start', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6 },
  bannerCtaText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  // CategoryChip
  categoryChip:   { alignItems: 'center', width: 72, paddingVertical: 6 },
  categoryCircle: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  categoryEmoji:  { fontSize: 24 },
  categoryLabel:  { color: '#555', fontSize: 10, textAlign: 'center' },

  // SearchBar
  searchBar:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f0f0f0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginHorizontal: 10, marginVertical: 6 },
  searchIcon:       { fontSize: 14, marginRight: 8 },
  searchPlaceholder: { color: '#999', fontSize: 13 },

  // FilterBar
  filterBar:  { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 10, paddingVertical: 6 },
  filterChip: { backgroundColor: '#f0f0f0', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: '#ddd' },
  filterText: { color: '#666', fontSize: 11 },

  // Layout helpers (used across screens)
  hCardWrapper: { width: 180, padding: 4 },
  gridRow:      { flexDirection: 'row', gap: 10, paddingHorizontal: 10, marginBottom: 10 },
  gridCell:     { flex: 1 },
  flowWrap:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingVertical: 4 },
  vListItem:    { paddingHorizontal: 10, marginBottom: 10 },
  hGridContainer: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 4 },
  hGridCol:       { width: 180, gap: 8 },
  hGridCell:      { height: 160 },
  bannerWrapper:  { width: 280, padding: 6 },
  categoryWrapper: { paddingHorizontal: 4 },
});
