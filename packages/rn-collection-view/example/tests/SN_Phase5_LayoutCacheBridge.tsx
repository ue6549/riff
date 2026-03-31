/**
 * ShadowNode Phase 5a — LayoutCache Bridge Test.
 *
 * Validates three-tier height resolution and ShadowNode ↔ LayoutCache bridge.
 *
 * Three tiers, demonstrated step by step:
 *   Tier 3: estimatedItemHeight (single number) — all items start at 60px
 *   Tier 2: heightForItem (per-item) — JS writes real heights to cache
 *   Tier 1: Yoga actuals — ShadowNode measures mounted children, writes back
 *
 * The test starts paused at Tier 3 so you can see uniform 60px placeholders,
 * then step through each tier with buttons.
 *
 * What to look for in the cache table:
 *   - "placeholder" = tier 3 (estimatedItemHeight)
 *   - "dirty"       = tier 2 (JS wrote heightForItem)
 *   - "measured"    = tier 1 (ShadowNode wrote Yoga actual)
 */
import React, {useState, useCallback, useEffect} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import RNCollectionViewContainer from '../components/RNCollectionViewContainerNativeComponent';
import NativeCollectionViewModule from '../components/NativeCollectionViewModule';

const nativeMod = NativeCollectionViewModule as unknown as {
  layoutCacheId: number;
  layoutCache: {
    clear(): void;
    setAttributes(attrs: object): void;
    getAttributes(key: string): any;
    getTotalContentSize(): {width: number; height: number};
    version(): number;
  };
  listLayout: {
    computeListLayout(params: object): void;
  };
};

const ITEM_COUNT = 20;
const ESTIMATED_HEIGHT = 60;
const ROW_SPACING = 8;
const INSET_TOP = 8;
const INSET_LEFT = 8;
const INSET_RIGHT = 8;
const INSET_BOTTOM = 8;

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d'];

// Actual heights: vary per item (40, 60, 80, 100, 120, 40, ...)
const ACTUAL_HEIGHTS = Array.from({length: ITEM_COUNT}, (_, i) => 40 + (i % 5) * 20);

// "heightForItem" simulated values — slightly off from actual (to distinguish tier 2 vs tier 1)
// In real usage this comes from the consumer's heightForItem callback.
const HEIGHT_FOR_ITEM = Array.from({length: ITEM_COUNT}, (_, i) => ACTUAL_HEIGHTS[i] + 5);

type CacheRow = {
  index: number;
  height: number;
  state: string;
  actual: number;
};

export default function SNPhase5LayoutCacheBridge() {
  const [layoutCacheVersion, setLayoutCacheVersion] = useState(0);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [rows, setRows] = useState<CacheRow[]>([]);
  const [step, setStep] = useState<'init' | 'tier3' | 'tier2' | 'tier1'>('init');

  const [showContainer, setShowContainer] = useState(false);
  const layoutCacheId = nativeMod.layoutCacheId;

  const readCache = useCallback(() => {
    const cs = nativeMod.layoutCache.getTotalContentSize();
    const v = nativeMod.layoutCache.version();
    setCacheVersion(v);
    setContentHeight(cs.height);

    const r: CacheRow[] = [];
    for (let i = 0; i < ITEM_COUNT; i++) {
      const attrs = nativeMod.layoutCache.getAttributes(`item-0-${i}`);
      r.push({
        index: i,
        height: attrs ? attrs.frame.height : 0,
        state: attrs ? (attrs.sizingState || '?') : 'MISSING',
        actual: ACTUAL_HEIGHTS[i],
      });
    }
    setRows(r);
  }, []);

  // Step 1: Seed with estimatedItemHeight (Tier 3)
  // Native container is NOT mounted — cache is pure JS state.
  const seedTier3 = useCallback(() => {
    setShowContainer(false);
    nativeMod.layoutCache.clear();
    nativeMod.listLayout.computeListLayout({
      itemCount: ITEM_COUNT,
      itemHeight: ESTIMATED_HEIGHT,
      rowSpacing: ROW_SPACING,
      sectionInsetTop: INSET_TOP,
      sectionInsetBottom: INSET_BOTTOM,
      sectionInsetLeft: INSET_LEFT,
      sectionInsetRight: INSET_RIGHT,
    });
    setStep('tier3');
    readCache(); // sync read — no ShadowNode involved yet
  }, [readCache]);

  // Step 2: Simulate heightForItem (Tier 2) — JS writes per-item heights.
  // Still no native container — cache only.
  const seedTier2 = useCallback(() => {
    for (let i = 0; i < ITEM_COUNT; i++) {
      const key = `item-0-${i}`;
      const existing = nativeMod.layoutCache.getAttributes(key);
      if (existing) {
        nativeMod.layoutCache.setAttributes({
          ...existing,
          frame: {...existing.frame, height: HEIGHT_FOR_ITEM[i]},
          sizingState: 'dirty', // marks as "JS provided, not yet Yoga-confirmed"
        });
      }
    }
    setStep('tier2');
    readCache(); // sync read — still no ShadowNode
  }, [readCache]);

  // Step 3: Mount the native container → ShadowNode runs layout() → Yoga measures
  // → ShadowNode writes actual heights back to cache (tier 1 overrides tier 2).
  const triggerTier1 = useCallback(() => {
    setShowContainer(true);
    setLayoutCacheVersion(v => v + 1);
    setStep('tier1');
    // Delay read so Fabric commit + ShadowNode layout() + write-back completes.
    setTimeout(readCache, 300);
  }, [readCache]);

  // Reset everything
  const reset = useCallback(() => {
    setShowContainer(false);
    nativeMod.layoutCache.clear();
    setLayoutCacheVersion(0);
    setStep('init');
    setRows([]);
    setCacheVersion(0);
    setContentHeight(0);
  }, []);

  // Color-code by state
  const stateColor = (state: string) => {
    if (state === 'measured') return '#0f0';
    if (state === 'dirty') return '#ff0';
    if (state === 'placeholder') return '#888';
    return '#f00';
  };

  const tierLabel = () => {
    switch (step) {
      case 'init': return 'Press "Seed Tier 3" to start';
      case 'tier3': return 'Tier 3: All items at estimatedItemHeight (60px). Gray = placeholder.';
      case 'tier2': return 'Tier 2: JS wrote heightForItem values. Yellow = dirty (JS-provided).';
      case 'tier1': return 'Tier 1: ShadowNode measured via Yoga. Green = measured (final).';
    }
  };

  return (
    <View style={S.root}>
      <View style={S.header}>
        <Text style={S.title}>Phase 5a — Three-Tier Height Resolution</Text>
        <Text style={S.explain}>{tierLabel()}</Text>

        <Text style={S.metric}>
          cacheId={layoutCacheId}  cacheVer={cacheVersion}  propVer={layoutCacheVersion}  contentH={contentHeight.toFixed(0)}
        </Text>

        {/* Cache table: index | cache height (state) | actual height */}
        <View style={S.table}>
          <View style={S.tableRow}>
            <Text style={[S.tableCell, S.tableHeader, {flex: 0.5}]}>#</Text>
            <Text style={[S.tableCell, S.tableHeader, {flex: 1.5}]}>Cache</Text>
            <Text style={[S.tableCell, S.tableHeader, {flex: 1}]}>Actual</Text>
            <Text style={[S.tableCell, S.tableHeader, {flex: 1}]}>Match?</Text>
          </View>
          {rows.slice(0, 12).map(r => {
            const match = Math.abs(r.height - r.actual) < 1;
            return (
              <View key={r.index} style={S.tableRow}>
                <Text style={[S.tableCell, {flex: 0.5, color: '#aaa'}]}>{r.index}</Text>
                <Text style={[S.tableCell, {flex: 1.5, color: stateColor(r.state)}]}>
                  {r.height.toFixed(0)} ({r.state})
                </Text>
                <Text style={[S.tableCell, {flex: 1, color: '#fff'}]}>{r.actual}</Text>
                <Text style={[S.tableCell, {flex: 1, color: match ? '#0f0' : '#f66'}]}>
                  {match ? 'YES' : 'NO'}
                </Text>
              </View>
            );
          })}
        </View>

        {/* Step buttons */}
        <View style={S.buttons}>
          <TouchableOpacity
            style={[S.btn, step !== 'init' && S.btnDim]}
            onPress={seedTier3}>
            <Text style={S.btnText}>1. Seed Tier 3</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[S.btn, step !== 'tier3' && S.btnDim]}
            onPress={seedTier2}>
            <Text style={S.btnText}>2. Seed Tier 2</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[S.btn, step !== 'tier2' && S.btnDim]}
            onPress={triggerTier1}>
            <Text style={S.btnText}>3. Trigger Tier 1</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[S.btn, S.btnReset]} onPress={reset}>
            <Text style={S.btnText}>Reset</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={S.btnSmall} onPress={readCache}>
          <Text style={S.btnSmallText}>Refresh Table</Text>
        </TouchableOpacity>
      </View>

      {showContainer ? (
        <RNCollectionViewContainer
          style={S.container}
          layoutCacheId={layoutCacheId}
          layoutCacheVersion={layoutCacheVersion}
          estimatedItemHeight={ESTIMATED_HEIGHT}
          renderRangeStart={0}
          renderRangeEnd={ITEM_COUNT - 1}
          rowSpacing={ROW_SPACING}
          sectionInsetTop={INSET_TOP}
          sectionInsetBottom={INSET_BOTTOM}
          sectionInsetLeft={INSET_LEFT}
          sectionInsetRight={INSET_RIGHT}
          scrollEventThrottle={16}
          bounces={true}
          onScroll={(e: any) => {
            setScrollY(e.nativeEvent.contentOffset.y);
          }}>
          {Array.from({length: ITEM_COUNT}, (_, i) => (
            <View
              key={i}
              collapsable={false}
              style={[S.item, {height: ACTUAL_HEIGHTS[i], backgroundColor: COLORS[i % COLORS.length]}]}>
              <Text style={S.itemText}>
                Item {i} — {ACTUAL_HEIGHTS[i]}px
              </Text>
            </View>
          ))}
        </RNCollectionViewContainer>
      ) : (
        <View style={[S.container, S.placeholder]}>
          <Text style={S.placeholderText}>
            {step === 'init'
              ? 'Press "1. Seed Tier 3" to start'
              : 'Native container not mounted yet.\nCache state shown in table above.\nPress next step to continue.'}
          </Text>
        </View>
      )}
    </View>
  );
}

const S = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#1a1a2e'},
  header: {paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4},
  title: {color: '#fff', fontSize: 15, fontWeight: '700'},
  explain: {color: '#adf', fontSize: 11, marginTop: 3, fontStyle: 'italic'},
  metric: {color: '#0f0', fontSize: 9, fontFamily: 'Menlo', marginTop: 3},
  table: {marginTop: 4, marginBottom: 2},
  tableRow: {flexDirection: 'row', paddingVertical: 1},
  tableCell: {fontSize: 9, fontFamily: 'Menlo'},
  tableHeader: {color: '#999', fontWeight: '700'},
  buttons: {flexDirection: 'row', gap: 6, marginTop: 6},
  btn: {backgroundColor: '#336', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4},
  btnDim: {opacity: 0.4},
  btnReset: {backgroundColor: '#633'},
  btnText: {color: '#fff', fontSize: 11, fontWeight: '600'},
  btnSmall: {backgroundColor: '#333', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 3, marginTop: 4, alignSelf: 'flex-start'},
  btnSmallText: {color: '#aaa', fontSize: 10},
  container: {flex: 1},
  placeholder: {justifyContent: 'center', alignItems: 'center', backgroundColor: '#111'},
  placeholderText: {color: '#666', fontSize: 13, textAlign: 'center'},
  item: {justifyContent: 'center', paddingHorizontal: 12, borderRadius: 6},
  itemText: {color: '#fff', fontSize: 13, fontWeight: '600'},
});
