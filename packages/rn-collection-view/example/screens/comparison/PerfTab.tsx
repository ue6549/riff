/**
 * Tab 5 — Performance Metrics (4 scenarios)
 *
 * Each scenario tests a different cell composition. Metrics overlay shows
 * FPS, blank area, mounted count, mount rate.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '../../components/CollectionView';
import { useFPS } from '../../utils/useMetrics';

// ── Scenarios ─────────────────────────────────────────────────────────────────

type Scenario = 1 | 2 | 3 | 4;

const SCENARIO_LABELS: Record<Scenario, string> = {
  1: 'Homo Fixed',
  2: 'Homo Dynamic',
  3: 'Hetero Repeat',
  4: 'Hetero Unique',
};

const SCENARIO_DESC: Record<Scenario, string> = {
  1: '10k identical cells · 44px fixed · FlashList best case',
  2: '10k same type · variable text · measurement overhead',
  3: '10k cells · 4 item types repeating · typed recycling pools',
  4: 'Product page · 50 unique components · recycling useless',
};

// ── Data generators ───────────────────────────────────────────────────────────

const COUNT = 10_000;
const COUNT_4 = 60; // Scenario 4: unique product page sections

type SimpleItem = { id: number; type: 'simple' };
type TextItem = { id: number; type: 'text'; lines: number; body: string };
type HeteroItem = { id: number; type: 'image' | 'text' | 'banner' | 'compact'; label: string };
type UniqueItem = { id: number; type: 'unique'; title: string; height: number; color: string };

const TEXTS = [
  'Short.',
  'A medium line that wraps to two lines on most devices.',
  'A longer paragraph with more content that exercises variable height measurement and scroll corrections when entering the viewport.',
  'Brief note.',
];

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d'];

function makeData1(): SimpleItem[] {
  return Array.from({ length: COUNT }, (_, i) => ({ id: i, type: 'simple' }));
}

function makeData2(): TextItem[] {
  return Array.from({ length: COUNT }, (_, i) => ({
    id: i, type: 'text',
    lines: 1 + (i % 4),
    body: TEXTS[i % TEXTS.length]!,
  }));
}

function makeData3(): HeteroItem[] {
  const types: HeteroItem['type'][] = ['image', 'text', 'banner', 'compact'];
  return Array.from({ length: COUNT }, (_, i) => ({
    id: i, type: types[i % types.length]!,
    label: `Item ${i}`,
  }));
}

function makeData4(): UniqueItem[] {
  const parts = [
    'Hero Image', 'Product Title', 'Price & Variants', 'Description',
    'Specs Table', 'Size Guide', 'Customer Reviews', 'Q&A Section',
    'Related Products', 'Recently Viewed', 'Shipping Info', 'Return Policy',
    'Seller Info', 'Product Story', 'Ingredients', 'Certifications',
    'Awards', 'Press Quotes', 'Social Proof', 'Newsletter Signup',
    'Legal Disclaimer', 'Warranty Info', 'FAQ', 'Contact Support',
    'Share Widget', 'Save for Later', 'Compare Products', 'Bundles',
    'Accessories', 'Installation Guide', 'Video Tutorial', 'Unboxing',
    'Community Posts', 'Expert Reviews', 'Price History', 'Sustainability',
    'Gift Options', 'Personalization', 'Subscription Plans', 'Loyalty Points',
    'Brand Story', 'Manufacturing', 'Materials', 'Care Instructions',
    'Dimensions', 'Weight', 'Color Options', 'Availability',
    'Delivery Estimate', 'Pickup Options', 'Assembly Required', 'Tools Needed',
    'Safety Warnings', 'Age Restrictions', 'Country of Origin', 'Barcode',
    'Model Number', 'Patent Info', 'Environmental Impact', 'Recycling',
  ];
  return Array.from({ length: COUNT_4 }, (_, i) => ({
    id: i, type: 'unique' as const,
    title: parts[i % parts.length]!,
    height: 80 + (i * 37) % 200,
    color: COLORS[i % COLORS.length]!,
  }));
}

// ── Mount counter ─────────────────────────────────────────────────────────────

let mountCount = 0;
function resetMounts() { mountCount = 0; }

function useMountTracker() {
  const mounted = useRef(false);
  if (!mounted.current) { mounted.current = true; mountCount++; }
}

// ── Cells ─────────────────────────────────────────────────────────────────────

function SimpleCell({ item }: { item: SimpleItem }) {
  useMountTracker();
  return (
    <View style={S.simpleCell}>
      <Text style={S.cellText}>Item {item.id}</Text>
    </View>
  );
}

function TextCell({ item }: { item: TextItem }) {
  useMountTracker();
  return (
    <View style={S.textCell}>
      <Text style={S.cellText}>{item.body}</Text>
    </View>
  );
}

function HeteroCell({ item }: { item: HeteroItem }) {
  useMountTracker();
  switch (item.type) {
    case 'image':
      return (
        <View style={S.imageCard}>
          <View style={[S.imagePlaceholder, { backgroundColor: COLORS[item.id % COLORS.length] }]}>
            <Text style={S.imageIcon}>🖼</Text>
          </View>
          <View style={S.imageBody}>
            <Text style={S.imageTitle}>{item.label}</Text>
            <Text style={S.imageSub}>Image card · 60px</Text>
          </View>
        </View>
      );
    case 'banner':
      return (
        <View style={[S.bannerCell, { backgroundColor: COLORS[(item.id + 2) % COLORS.length] }]}>
          <Text style={S.bannerTitle}>FEATURED</Text>
          <Text style={S.bannerSub}>{item.label}</Text>
        </View>
      );
    case 'compact':
      return (
        <View style={S.compactCell}>
          <View style={[S.compactDot, { backgroundColor: COLORS[(item.id + 4) % COLORS.length] }]} />
          <Text style={S.compactText}>{item.label}</Text>
        </View>
      );
    default: // 'text'
      return (
        <View style={S.textRowCell}>
          <Text style={S.cellText}>{item.label}</Text>
          <Text style={S.textRowSub}>Text row · standard height</Text>
        </View>
      );
  }
}

function UniqueCell({ item }: { item: UniqueItem }) {
  useMountTracker();
  // Each cell is a distinct "widget" — hero, specs, reviews, etc.
  // No two look the same. Recycling pool never hits.
  const isEven = item.id % 2 === 0;
  return (
    <View style={[S.uniqueCell, { height: item.height, borderLeftColor: item.color }]}>
      <Text style={S.uniqueTitle}>{item.title}</Text>
      {isEven ? (
        <View style={S.uniqueContent}>
          <View style={[S.uniqueBlock, { backgroundColor: item.color, width: '60%', height: 20 }]} />
          <View style={[S.uniqueBlock, { backgroundColor: '#333', width: '40%', height: 12, marginTop: 6 }]} />
          <View style={[S.uniqueBlock, { backgroundColor: '#222', width: '80%', height: 12, marginTop: 4 }]} />
        </View>
      ) : (
        <View style={S.uniqueContent}>
          <View style={S.uniqueRow}>
            <View style={[S.uniqueChip, { backgroundColor: item.color }]} />
            <View style={[S.uniqueChip, { backgroundColor: '#333' }]} />
            <View style={[S.uniqueChip, { backgroundColor: '#444' }]} />
          </View>
          <View style={[S.uniqueBlock, { backgroundColor: '#222', width: '90%', height: 10, marginTop: 8 }]} />
        </View>
      )}
      <Text style={S.uniqueSub}>Widget #{item.id} · {item.height}px · unique layout</Text>
    </View>
  );
}

// ── Metrics overlay ───────────────────────────────────────────────────────────

function Metrics({ renderCount }: { renderCount: number }) {
  const fps = useFPS();
  return (
    <View style={S.overlay} pointerEvents="none">
      <Text style={S.metricLine}>FPS: <Text style={S.metricVal}>{fps}</Text></Text>
      <Text style={S.metricLine}>Rendered: <Text style={S.metricVal}>{renderCount}</Text></Text>
      <Text style={S.metricLine}>Mounts: <Text style={S.metricVal}>{mountCount}</Text></Text>
    </View>
  );
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export default function PerfTab({ mode }: { mode: 'cv' | 'flash' }) {
  const [scenario, setScenario] = useState<Scenario>(1);
  const [renderCount, setRenderCount] = useState(0);

  const handleScenario = useCallback((s: Scenario) => {
    resetMounts();
    setScenario(s);
  }, []);

  return (
    <View style={S.root}>
      {/* Scenario picker */}
      <View style={S.picker}>
        {([1, 2, 3, 4] as Scenario[]).map(s => (
          <Pressable
            key={s}
            style={[S.pickBtn, scenario === s && S.pickBtnActive]}
            onPress={() => handleScenario(s)}
          >
            <Text style={[S.pickText, scenario === s && S.pickTextActive]}>
              {SCENARIO_LABELS[s]}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={S.desc}>{SCENARIO_DESC[scenario]}</Text>

      <View style={S.listArea}>
        <Metrics renderCount={renderCount} />
        <ScenarioList scenario={scenario} mode={mode} onRenderCount={setRenderCount} />
      </View>
    </View>
  );
}

// Each scenario is a separate component so hooks are unconditional.
// The parent uses `key={scenario}` to force remount on scenario change.

function ScenarioList({
  scenario, mode, onRenderCount,
}: {
  scenario: Scenario; mode: 'cv' | 'flash'; onRenderCount: (n: number) => void;
}) {
  return (
    <>
      {scenario === 1 && <Scenario1 mode={mode} onRenderCount={onRenderCount} key="s1" />}
      {scenario === 2 && <Scenario2 mode={mode} onRenderCount={onRenderCount} key="s2" />}
      {scenario === 3 && <Scenario3 mode={mode} onRenderCount={onRenderCount} key="s3" />}
      {scenario === 4 && <Scenario4 mode={mode} onRenderCount={onRenderCount} key="s4" />}
    </>
  );
}

type ScenarioProps = { mode: 'cv' | 'flash'; onRenderCount: (n: number) => void };

function Scenario1({ mode, onRenderCount }: ScenarioProps) {
  const data = React.useMemo(() => makeData1(), []);
  const keyEx = React.useCallback((i: SimpleItem) => String(i.id), []);
  const renderSimple = React.useCallback(({ item }: { item: SimpleItem }) => <SimpleCell item={item} />, []);
  return mode === 'cv' ? (
    <Riff data={data} keyExtractor={keyEx} itemHeight={44}
      renderItem={renderSimple} onRenderCountChange={onRenderCount} />
  ) : (
    <FlashList data={data} keyExtractor={keyEx} estimatedItemSize={44}
      renderItem={({ item }) => <SimpleCell item={item} />} />
  );
}

function Scenario2({ mode, onRenderCount }: ScenarioProps) {
  const data = React.useMemo(() => makeData2(), []);
  const keyEx = React.useCallback((i: TextItem) => String(i.id), []);
  const renderText = React.useCallback(({ item }: { item: TextItem }) => <TextCell item={item} />, []);
  return mode === 'cv' ? (
    <Riff data={data} keyExtractor={keyEx} estimatedItemHeight={60}
      renderItem={renderText} onRenderCountChange={onRenderCount} />
  ) : (
    <FlashList data={data} keyExtractor={keyEx} estimatedItemSize={60}
      renderItem={({ item }) => <TextCell item={item} />} />
  );
}

function Scenario3({ mode, onRenderCount }: ScenarioProps) {
  const data = React.useMemo(() => makeData3(), []);
  const keyEx = React.useCallback((i: HeteroItem) => String(i.id), []);
  const renderHetero = React.useCallback(({ item }: { item: HeteroItem }) => <HeteroCell item={item} />, []);
  // Declare 4 item types so FlashList creates typed recycling pools.
  // This is FlashList's design target — pool per type, reuse within type.
  const heteroSizes: Record<string, number> = { image: 60, banner: 80, compact: 32, text: 44 };
  const overrideLayout3 = React.useCallback((layout: { size?: number; type?: string | number }, item: HeteroItem) => {
    layout.type = item.type;
    layout.size = heteroSizes[item.type] ?? 50;
  }, []);
  return mode === 'cv' ? (
    <Riff data={data} keyExtractor={keyEx} estimatedItemHeight={50}
      renderItem={renderHetero} onRenderCountChange={onRenderCount} />
  ) : (
    <FlashList data={data} keyExtractor={keyEx} estimatedItemSize={50}
      overrideItemLayout={overrideLayout3}
      renderItem={({ item }) => <HeteroCell item={item} />} />
  );
}

function Scenario4({ mode, onRenderCount }: ScenarioProps) {
  const data = React.useMemo(() => makeData4(), []);
  const keyEx = React.useCallback((i: UniqueItem) => String(i.id), []);
  const renderUnique = React.useCallback(({ item }: { item: UniqueItem }) => <UniqueCell item={item} />, []);
  // Every item gets a unique type — recycling pool never hits.
  // FlashList creates a pool-of-1 per item, effectively no reuse.
  const overrideLayout4 = React.useCallback((layout: { size?: number; type?: string | number }, item: UniqueItem) => {
    layout.type = `unique-${item.id}`;
    layout.size = item.height;
  }, []);
  return mode === 'cv' ? (
    <Riff data={data} keyExtractor={keyEx} estimatedItemHeight={120}
      renderItem={renderUnique} onRenderCountChange={onRenderCount} />
  ) : (
    <FlashList data={data} keyExtractor={keyEx} estimatedItemSize={120}
      overrideItemLayout={overrideLayout4}
      renderItem={({ item }) => <UniqueCell item={item} />} />
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  picker: { flexDirection: 'row', gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  pickBtn: { flex: 1, paddingVertical: 5, borderRadius: 6, backgroundColor: '#1a1a1a',
             alignItems: 'center' },
  pickBtnActive: { backgroundColor: '#1e3a1e' },
  pickText: { fontSize: 10, fontWeight: '600', color: '#555' },
  pickTextActive: { color: '#4ade80' },
  desc: { fontSize: 10, color: '#4a5568', paddingHorizontal: 12, paddingBottom: 4 },
  listArea: { flex: 1 },

  overlay: { position: 'absolute', top: 8, right: 8, backgroundColor: '#000a',
             borderRadius: 8, padding: 8, minWidth: 120, zIndex: 100 },
  metricLine: { fontSize: 10, color: '#94a3b8', fontFamily: 'Menlo' },
  metricVal: { color: '#4ade80' },

  simpleCell: { height: 44, justifyContent: 'center', paddingHorizontal: 16,
                borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  textCell: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  cellText: { fontSize: 13, color: '#ccc' },

  // ── Hetero: image card ──
  imageCard: { height: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
               borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  imagePlaceholder: { width: 40, height: 40, borderRadius: 8, alignItems: 'center',
                      justifyContent: 'center', marginRight: 10 },
  imageIcon: { fontSize: 18 },
  imageBody: { flex: 1 },
  imageTitle: { fontSize: 13, fontWeight: '600', color: '#e2e8f0' },
  imageSub: { fontSize: 10, color: '#4a5568', marginTop: 2 },

  // ── Hetero: banner ──
  bannerCell: { height: 80, justifyContent: 'center', alignItems: 'center',
                borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  bannerTitle: { fontSize: 16, fontWeight: '800', color: '#fff', letterSpacing: 2 },
  bannerSub: { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 4 },

  // ── Hetero: compact ──
  compactCell: { height: 32, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
                 borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1a1a1a' },
  compactDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  compactText: { fontSize: 11, color: '#888' },

  // ── Hetero: text row ──
  textRowCell: { height: 44, justifyContent: 'center', paddingHorizontal: 16,
                 borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  textRowSub: { fontSize: 10, color: '#4a5568', marginTop: 1 },

  // ── Unique product page widgets ──
  uniqueCell: { justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10,
                borderLeftWidth: 4, borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: '#222' },
  uniqueTitle: { fontSize: 14, fontWeight: '700', color: '#e2e8f0' },
  uniqueContent: { marginTop: 8 },
  uniqueBlock: { borderRadius: 4 },
  uniqueRow: { flexDirection: 'row', gap: 8 },
  uniqueChip: { width: 40, height: 20, borderRadius: 10 },
  uniqueSub: { fontSize: 10, color: '#4a5568', marginTop: 8 },
});
