/**
 * Compositional Layout Demo
 *
 * Six sections demonstrating cross-section slot recycling via getItemType:
 *   S0 — List    — Banners       (type: 'banner')
 *   S1 — Grid    — Categories    (type: 'category')
 *   S2 — Flow H  — Deal tags     (type: 'tag')  H↔  ← shares pool with S4
 *   S3 — List    — Featured products (type: 'product') ← shares pool with S5
 *   S4 — Flow    — Trending tags (type: 'tag')      ← shares pool with S2
 *   S5 — Masonry — All products  (type: 'product')  ← shares pool with S3
 *
 * When scrolling past S3 into S5, product slots from S3 are immediately
 * recycled for S5 — Cold counter stays flat at that boundary.
 * Same for tag slots crossing S2→S4.
 *
 * renderItem dispatches on item._type, not section index — section-agnostic,
 * which is the correct production pattern.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Riff as CollectionView, type RiffHandle } from '@riff/components/CollectionView';
import { compositional } from '@riff/layouts/compositional';
import { list } from '@riff/layouts/list';
import { grid } from '@riff/layouts/grid';
import { flow } from '@riff/layouts/flow';
import { masonry } from '@riff/layouts/masonry';
import type { RiffSection } from '@riff/types/protocol';

// ── Item types — explicit _type discriminant ──────────────────────────────────

type BannerItem   = { id: string; _type: 'banner';   label: string; color: string };
type CategoryItem = { id: string; _type: 'category'; icon: string; label: string; color: string };
type TagItem      = { id: string; _type: 'tag';      label: string; color: string; width: number };
type ProductItem  = { id: string; _type: 'product';  label: string; price: string; color: string; description: string };
type AnyItem      = BannerItem | CategoryItem | TagItem | ProductItem;

// ── Colors ────────────────────────────────────────────────────────────────────

const COLORS = [
  '#e63946', '#2a9d8f', '#e9c46a', '#f4a261',
  '#264653', '#457b9d', '#6a4c93', '#1982c4',
];

// ── S0: Banners (List) ────────────────────────────────────────────────────────

const BANNER_SEED: BannerItem[] = [
  { id: 'b0', _type: 'banner', label: '🔥  Flash Sale — Up to 70% off', color: '#c1121f' },
  { id: 'b1', _type: 'banner', label: '🆕  New Arrivals — Just Landed',  color: '#2a9d8f' },
  { id: 'b2', _type: 'banner', label: '⭐  Top Rated — Bestsellers',     color: '#e9c46a' },
];

// ── S1: Categories (Grid) ─────────────────────────────────────────────────────

const CATEGORY_DATA: CategoryItem[] = [
  { id: 'c0', _type: 'category', icon: '👗', label: 'Fashion',     color: '#e63946' },
  { id: 'c1', _type: 'category', icon: '📱', label: 'Electronics', color: '#457b9d' },
  { id: 'c2', _type: 'category', icon: '🏠', label: 'Home',        color: '#2a9d8f' },
  { id: 'c3', _type: 'category', icon: '📚', label: 'Books',       color: '#6a4c93' },
  { id: 'c4', _type: 'category', icon: '🍳', label: 'Kitchen',     color: '#f4a261' },
  { id: 'c5', _type: 'category', icon: '⚽', label: 'Sports',      color: '#264653' },
  { id: 'c6', _type: 'category', icon: '💄', label: 'Beauty',      color: '#1982c4' },
  { id: 'c7', _type: 'category', icon: '🧸', label: 'Toys',        color: '#e9c46a' },
];

// ── S2: Deal tags (Flow) — shares 'tag' pool with S4 ─────────────────────────

const DEAL_TAGS: TagItem[] = [
  { id: 't0',  _type: 'tag', label: 'Under ₹499',     color: '#e63946', width: 110 },
  { id: 't1',  _type: 'tag', label: 'Free Delivery',  color: '#2a9d8f', width: 130 },
  { id: 't2',  _type: 'tag', label: 'Best Seller',    color: '#e9c46a', width: 105 },
  { id: 't3',  _type: 'tag', label: 'New Arrivals',   color: '#f4a261', width: 120 },
  { id: 't4',  _type: 'tag', label: '4★ & above',     color: '#264653', width: 100 },
  { id: 't5',  _type: 'tag', label: 'Flash Deal',     color: '#457b9d', width: 100 },
  { id: 't6',  _type: 'tag', label: 'Trending Now',   color: '#6a4c93', width: 120 },
  { id: 't7',  _type: 'tag', label: 'Clearance Sale', color: '#1982c4', width: 135 },
  { id: 't8',  _type: 'tag', label: 'Combo Offer',    color: '#e63946', width: 115 },
  { id: 't9',  _type: 'tag', label: 'EMI Available',  color: '#2a9d8f', width: 125 },
  { id: 't10', _type: 'tag', label: 'In Stock Only',  color: '#e9c46a', width: 115 },
  { id: 't11', _type: 'tag', label: 'Exchange Offer', color: '#f4a261', width: 135 },
  { id: 't12', _type: 'tag', label: 'Today Only',     color: '#264653', width: 100 },
  { id: 't13', _type: 'tag', label: 'Sponsored',      color: '#457b9d', width: 100 },
  { id: 't14', _type: 'tag', label: 'Eco Friendly',   color: '#6a4c93', width: 115 },
  { id: 't15', _type: 'tag', label: 'Express Ship',   color: '#1982c4', width: 120 },
  { id: 't16', _type: 'tag', label: 'Bundle & Save',  color: '#e63946', width: 125 },
  { id: 't17', _type: 'tag', label: 'Staff Pick',     color: '#2a9d8f', width: 100 },
  { id: 't18', _type: 'tag', label: 'Wholesale',      color: '#e9c46a', width: 100 },
  { id: 't19', _type: 'tag', label: 'Limited Edition',color: '#f4a261', width: 145 },
];

// ── S3: Featured products (List) — shares 'product' pool with S5 ─────────────
// Same ProductCell component, different layout (full-width list vs masonry).

const FEATURED_PRODUCTS: ProductItem[] = [
  { id: 'fp0', _type: 'product', label: 'Top Pick',        price: '₹999',  color: '#e63946',
    description: 'Our most loved product. Premium quality and unbeatable durability.' },
  { id: 'fp1', _type: 'product', label: "Editor's Choice", price: '₹1499', color: '#2a9d8f',
    description: 'Handpicked by our editorial team. Award-winning design meets practical everyday use. Available in multiple colors and sizes to suit your needs.' },
  { id: 'fp2', _type: 'product', label: 'Best Value',      price: '₹799',  color: '#e9c46a',
    description: 'Great price.' },
  { id: 'fp3', _type: 'product', label: 'Staff Pick',      price: '₹1299', color: '#457b9d',
    description: 'Recommended by our in-store team. Perfect blend of style and function. Built to last with eco-friendly materials sourced from certified suppliers.' },
];

// ── S4: Trending tags (Flow) — shares 'tag' pool with S2 ─────────────────────

const TRENDING_TAGS: TagItem[] = [
  { id: 'tr0', _type: 'tag', label: 'Just Launched',  color: '#e63946', width: 125 },
  { id: 'tr1', _type: 'tag', label: 'Most Wished',    color: '#2a9d8f', width: 115 },
  { id: 'tr2', _type: 'tag', label: '#1 in Category', color: '#e9c46a', width: 130 },
  { id: 'tr3', _type: 'tag', label: 'Price Drop',     color: '#f4a261', width: 105 },
  { id: 'tr4', _type: 'tag', label: 'Back in Stock',  color: '#264653', width: 120 },
  { id: 'tr5', _type: 'tag', label: 'Going Fast',     color: '#457b9d', width: 110 },
  { id: 'tr6', _type: 'tag', label: 'Handpicked',     color: '#6a4c93', width: 110 },
  { id: 'tr7', _type: 'tag', label: 'Fan Favourite',  color: '#1982c4', width: 120 },
  { id: 'tr8', _type: 'tag', label: 'Social Buzz',    color: '#e63946', width: 110 },
  { id: 'tr9', _type: 'tag', label: 'Weekend Deal',   color: '#2a9d8f', width: 115 },
];

// ── S5: All products (Masonry) — mutable, shares 'product' pool with S3 ──────
// Descriptions vary in length to produce genuine content-driven height variance.

const PRODUCT_DESCRIPTIONS = [
  'Compact and reliable.',
  'Top-rated by thousands of customers. Excellent build quality and fast shipping included.',
  'Budget-friendly.',
  'Crafted with premium materials. Lightweight yet strong. Ideal for daily use. Comes with a 1-year warranty and free returns.',
  'Bestseller.',
  'Sleek modern design with smart features. Loved by professionals and enthusiasts alike for its consistent performance.',
  'Good value.',
  'Eco-friendly packaging. Sustainable materials. Zero-waste production process certified by international standards.',
  'Highly recommended.',
  'Versatile and durable. Works in all weather conditions. Endorsed by industry experts and awarded Best Product of the Year.',
];

const PRODUCT_SEED: ProductItem[] = Array.from({ length: 30 }, (_, i) => ({
  id: `p${i}`,
  _type: 'product' as const,
  label: `Product ${i + 1}`,
  price: `₹${(i + 1) * 299 + (i % 7) * 100}`,
  color: COLORS[i % COLORS.length]!,
  description: PRODUCT_DESCRIPTIONS[i % PRODUCT_DESCRIPTIONS.length]!,
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const HEADER_H = 44;
const FOOTER_H = 28;

// ── Control widgets ───────────────────────────────────────────────────────────

function CtrlBtn({ label, onPress, disabled, active }: {
  label: string; onPress?: () => void; disabled?: boolean; active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
        backgroundColor: disabled ? '#1a1a1a' : active ? '#1e3a1e' : '#2a2a2a',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: disabled ? '#444' : active ? '#4ade80' : '#ccc', fontSize: 11, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function CtrlDivider() {
  return <View style={{ width: 1, height: 18, backgroundColor: '#333', marginHorizontal: 2 }} />;
}

// ── Section chrome ────────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionSubtitle}>{subtitle}</Text>
    </View>
  );
}

function SectionFooter({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.sectionFooter, { borderTopColor: color + '66', backgroundColor: color + '18' }]}>
      <Text style={[styles.sectionFooterText, { color: color + 'cc' }]}>{label}</Text>
    </View>
  );
}

// ── Cells ─────────────────────────────────────────────────────────────────────

function BannerCell({ item }: { item: BannerItem }) {
  return (
    <View style={[styles.bannerCell, { backgroundColor: item.color }]}>
      <Text style={styles.bannerLabel}>{item.label}</Text>
    </View>
  );
}

function CategoryCell({ item }: { item: CategoryItem }) {
  return (
    <View style={[styles.categoryCell, { backgroundColor: item.color + '22', borderColor: item.color + '66' }]}>
      <Text style={styles.categoryIcon}>{item.icon}</Text>
      <Text style={[styles.categoryLabel, { color: item.color }]}>{item.label}</Text>
    </View>
  );
}

function TagCell({ item }: { item: TagItem }) {
  return (
    <View style={[styles.tagCell, { backgroundColor: item.color + '22', borderColor: item.color }]}>
      <Text style={[styles.tagLabel, { color: item.color }]}>{item.label}</Text>
    </View>
  );
}

function ProductCell({ item, expanded }: { item: ProductItem; expanded: boolean }) {
  return (
    <View style={[styles.productCell, { backgroundColor: item.color + '22', borderColor: item.color + '44' }]}>
      <View style={[styles.productImg, { backgroundColor: item.color + '44' }]} />
      <Text style={styles.productLabel}>{item.label}</Text>
      <Text style={[styles.productPrice, { color: item.color }]}>{item.price}</Text>
      <Text style={styles.productDesc}>{item.description}</Text>
      {expanded && (
        <View style={[styles.productExpanded, { borderTopColor: item.color + '44' }]}>
          <Text style={[styles.productExpandedText, { color: item.color }]}>
            {'📦 Free delivery  •  ★ 4.5  •  2,341 reviews\n🔁 30-day return  •  ✓ Authentic'}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

let bannerCounter = BANNER_SEED.length;
let productCounter = PRODUCT_SEED.length;

export function CompositionalDemo() {
  const cvRef = useRef<RiffHandle<AnyItem>>(null);
  const [banners, setBanners]       = useState<BannerItem[]>(BANNER_SEED);
  const [products, setProducts]     = useState<ProductItem[]>(PRODUCT_SEED);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [mvcEnabled, setMvcEnabled] = useState(false);
  const [hudEnabled, setHudEnabled] = useState(false);

  // productsRef kept for potential future heightForItem callbacks.
  const productsRef = useRef(products);
  productsRef.current = products;

  // ── Mutations ────────────────────────────────────────────────────────────────

  const insertBanner = useCallback(() => {
    const i = bannerCounter++;
    setBanners(prev => [{ id: `b-ins-${i}`, _type: 'banner', label: `🎯  Banner ${i}`, color: COLORS[i % COLORS.length]! }, ...prev]);
  }, []);
  const deleteBanner = useCallback(() => setBanners(prev => prev.length > 1 ? prev.slice(1) : prev), []);

  const insertProduct = useCallback(() => {
    const i = productCounter++;
    setProducts(prev => [{
      id: `p-ins-${i}`, _type: 'product', label: `New Product ${i}`,
      price: `₹${i * 99 + 199}`, color: COLORS[i % COLORS.length]!,
      description: PRODUCT_DESCRIPTIONS[i % PRODUCT_DESCRIPTIONS.length]!,
    }, ...prev]);
  }, []);
  const deleteProduct = useCallback(() => setProducts(prev => prev.length > 1 ? prev.slice(1) : prev), []);

  const toggleExpandedProduct = useCallback(() => {
    const firstId = productsRef.current[0]?.id ?? null;
    setExpandedProductId(prev => prev === firstId ? null : firstId);
  }, []);

  // ── Layout (stable — heightForItem reads via refs) ───────────────────────────

  const layout = useMemo(() => compositional([
    { range: 0, layout: list({ estimatedItemHeight: 200, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', itemSpacing: 10 }) },
    { range: 1, layout: grid({ columns: 2, estimatedItemHeight: 90, columnSpacing: 10, rowSpacing: 10, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push' }) },
    { range: 2, layout: flow({ estimatedSizeForItem: (_s, i) => ({ width: DEAL_TAGS[i]?.width ?? 100, height: 36 }), itemSpacing: 8, lineSpacing: 8, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push' }), horizontal: true },
    { range: 3, layout: list({ estimatedItemHeight: 130, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push', itemSpacing: 10 }) },
    { range: 4, layout: flow({ estimatedSizeForItem: (_s, i) => ({ width: TRENDING_TAGS[i]?.width ?? 100, height: 36 }), itemSpacing: 8, lineSpacing: 8, headerHeight: HEADER_H, footerHeight: FOOTER_H, stickyMode: 'push' }) },
    { range: 5, layout: masonry({
        columns: 2,
        estimatedItemHeight: 130,
        columnSpacing: 10, rowSpacing: 10,
        headerHeight: HEADER_H, footerHeight: FOOTER_H,
        stickyMode: 'push',
      }),
    },
  ]), []);

  // ── Sections (rebuilt on data changes) ───────────────────────────────────────

  const sections = useMemo<RiffSection<AnyItem>[]>(() => [
    {
      key: 'banners', data: banners as AnyItem[],
      header: { render: () => <SectionHeader title={`Featured (${banners.length})`} subtitle="list · type: banner" />, height: HEADER_H, sticky: true },
      footer: { render: () => <SectionFooter label={`${banners.length} banners`} color="#c1121f" />, height: FOOTER_H, sticky: true },
      insets: { top: 10, bottom: 10, left: 12, right: 12 },
    },
    {
      key: 'categories', data: CATEGORY_DATA as AnyItem[],
      header: { render: () => <SectionHeader title="Categories" subtitle="grid · 2 cols · type: category" />, height: HEADER_H, sticky: true },
      footer: { render: () => <SectionFooter label={`${CATEGORY_DATA.length} categories`} color="#457b9d" />, height: FOOTER_H, sticky: true },
      insets: { top: 10, bottom: 10, left: 12, right: 12 },
    },
    {
      key: 'deal-tags', data: DEAL_TAGS as AnyItem[],
      header: { render: () => <SectionHeader title="Deals & Filters" subtitle="flow H ↔ · type: tag  ←  pool shared with S4" />, height: HEADER_H, sticky: true },
      footer: { render: () => <SectionFooter label={`${DEAL_TAGS.length} deal tags · H carousel`} color="#6a4c93" />, height: FOOTER_H, sticky: true },
      insets: { top: 10, bottom: 10, left: 12, right: 12 },
    },
    {
      key: 'featured-products', data: FEATURED_PRODUCTS as AnyItem[],
      header: { render: () => <SectionHeader title="Featured Products" subtitle="list · type: product  ←  pool shared with S5" />, height: HEADER_H, sticky: true },
      footer: { render: () => <SectionFooter label={`${FEATURED_PRODUCTS.length} featured`} color="#e63946" />, height: FOOTER_H, sticky: true },
      insets: { top: 10, bottom: 10, left: 12, right: 12 },
    },
    {
      key: 'trending-tags', data: TRENDING_TAGS as AnyItem[],
      header: { render: () => <SectionHeader title="Trending" subtitle="flow · type: tag  ←  pool shared with S2" />, height: HEADER_H, sticky: true },
      footer: { render: () => <SectionFooter label={`${TRENDING_TAGS.length} trending tags`} color="#f4a261" />, height: FOOTER_H, sticky: true },
      insets: { top: 10, bottom: 10, left: 12, right: 12 },
    },
    {
      key: 'products', data: products as AnyItem[],
      header: { render: () => <SectionHeader title={`All Products (${products.length})`} subtitle="masonry · 2 cols · type: product  ←  pool shared with S3" />, height: HEADER_H, sticky: true },
      footer: { render: () => <SectionFooter label={`${products.length} products`} color="#2a9d8f" />, height: FOOTER_H, sticky: true },
      insets: { top: 10, bottom: 10, left: 12, right: 12 },
    },
  ], [banners, products]);

  // ── Callbacks — section-agnostic, dispatch on _type ──────────────────────────

  const keyExtractor = useCallback((item: AnyItem) => item.id, []);
  const getItemType  = useCallback((item: AnyItem) => item._type, []);

  const renderItem = useCallback(({ item }: { item: AnyItem }) => {
    if (item._type === 'banner')   return <BannerCell   item={item} />;
    if (item._type === 'category') return <CategoryCell item={item} />;
    if (item._type === 'tag')      return <TagCell      item={item} />;
    return <ProductCell item={item as ProductItem} expanded={expandedProductId === item.id} />;
  }, [expandedProductId]);

  return (
    <View style={styles.root}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.ctrlBarScroll} contentContainerStyle={styles.ctrlBar}>
        <CtrlBtn label="→ Top"      onPress={() => cvRef.current?.scrollToTop()} />
        <CtrlBtn label="→ Cats"     onPress={() => cvRef.current?.scrollToSection(1, { position: 'top' })} />
        <CtrlBtn label="→ Tags"     onPress={() => cvRef.current?.scrollToSection(2, { position: 'top' })} />
        <CtrlBtn label="→ Feat"     onPress={() => cvRef.current?.scrollToSection(3, { position: 'top' })} />
        <CtrlBtn label="→ Trend"    onPress={() => cvRef.current?.scrollToSection(4, { position: 'top' })} />
        <CtrlBtn label="→ Products" onPress={() => cvRef.current?.scrollToSection(5, { position: 'top' })} />
        <CtrlBtn label="→ Bot"      onPress={() => cvRef.current?.scrollToEnd()} />
        <CtrlDivider />
        <CtrlBtn label="+Banner"  onPress={insertBanner} />
        <CtrlBtn label="−Banner"  onPress={deleteBanner}  disabled={banners.length <= 1} />
        <CtrlDivider />
        <CtrlBtn label="+Product" onPress={insertProduct} />
        <CtrlBtn label="−Product" onPress={deleteProduct} disabled={products.length <= 1} />
        <CtrlBtn label="↕ P[0]"   onPress={toggleExpandedProduct} active={expandedProductId !== null} />
        <CtrlDivider />
        <CtrlBtn label={mvcEnabled ? 'MVC: ON' : 'MVC: OFF'} onPress={() => setMvcEnabled(v => !v)} active={mvcEnabled} />
        <CtrlBtn label={hudEnabled ? 'HUD: ON' : 'HUD'}      onPress={() => setHudEnabled(v => !v)}  active={hudEnabled} />
      </ScrollView>

      <CollectionView
        ref={cvRef}
        sections={sections}
        layout={layout}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        renderItem={renderItem}
        extraData={expandedProductId}
        maintainVisibleContentPosition={mvcEnabled}
        showHUD={hudEnabled}
        scrollViewProps={{ contentInsetAdjustmentBehavior: 'automatic' }}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },

  ctrlBarScroll: { flexGrow: 0, backgroundColor: '#111' },
  ctrlBar:       { flexDirection: 'row', gap: 6, paddingHorizontal: 8, paddingVertical: 7, alignItems: 'center' },

  sectionHeader: {
    height: HEADER_H, backgroundColor: '#111',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a2a2a',
    justifyContent: 'center', paddingHorizontal: 14,
  },
  sectionTitle:    { color: '#fff', fontSize: 14, fontWeight: '700' },
  sectionSubtitle: { color: '#555', fontSize: 11, marginTop: 1 },

  sectionFooter: {
    height: FOOTER_H, borderTopWidth: 1,
    justifyContent: 'center', paddingHorizontal: 14,
  },
  sectionFooterText: { fontSize: 11, fontWeight: '600' },

  bannerCell: { height: 200, borderRadius: 10, justifyContent: 'center', paddingHorizontal: 20 },
  bannerLabel: { color: '#fff', fontSize: 18, fontWeight: '700' },

  categoryCell: {
    height: 90, borderRadius: 10, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  categoryIcon:  { fontSize: 28 },
  categoryLabel: { fontSize: 11, fontWeight: '600' },

  tagCell: {
    height: 36, borderRadius: 18, borderWidth: 1,
    paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center',
  },
  tagLabel: { fontSize: 12, fontWeight: '600' },

  productCell:         { borderRadius: 10, borderWidth: 1, padding: 10, overflow: 'hidden' },
  productImg:          { height: 60, borderRadius: 6, marginBottom: 8 },
  productLabel:        { color: '#ccc', fontSize: 12, fontWeight: '600', marginBottom: 4 },
  productPrice:        { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  productDesc:         { color: '#888', fontSize: 11, lineHeight: 15 },
  productExpanded:     { marginTop: 8, paddingTop: 8, borderTopWidth: 1 },
  productExpandedText: { fontSize: 10, lineHeight: 16 },
});
