/**
 * Comparison screen — CollectionView vs FlashList vs FlatList.
 *
 * All three implementations render the same complex ComparisonCell.
 * The cell has local like state (useState) that is NOT derived from props.
 *
 * What to observe:
 *   · FlashList: scrolling fast causes the like state from one cell to bleed
 *     into a different item (recycling artifact). Mount count stays low.
 *   · FlatList: no recycling, but renders ALL items (no windowing). Mount count
 *     equals item count. Memory pressure grows with list size.
 *   · CollectionView: virtualized, no recycling. Mount count matches
 *     rendered window size × scroll distance. Like state is always correct.
 *     C++ layout engine + C++ window controller on every scroll tick.
 *
 * Metrics overlay (top-right):
 *   FPS — live frame rate via RAF
 *   Rendered — current render window size (CollectionView only)
 *   Mounts — cumulative cell mount count since screen opened
 */
import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';

import { CollectionView } from '../components/CollectionView';
import {
  ComparisonCell,
  getMountCount,
  makeComparisonData,
  resetMountCount,
} from '../components/ComparisonCell';
import { useFPS } from '../utils/useMetrics';

// ─── Dataset ──────────────────────────────────────────────────────────────────

const ITEM_COUNT = 500;
const ITEM_H     = 88; // enough for avatar + 2 lines + actions
const DATA       = makeComparisonData(ITEM_COUNT);

// ─── Tab type ─────────────────────────────────────────────────────────────────

type Tab = 'cv' | 'flash' | 'flat';

const TABS: { id: Tab; label: string }[] = [
  { id: 'cv',    label: 'CV' },
  { id: 'flash', label: 'Flash'  },
  { id: 'flat',  label: 'Flat'   },
];

// ─── Metrics overlay ──────────────────────────────────────────────────────────

function MetricsOverlay({
  renderCount,
  totalCount,
  tab,
}: {
  renderCount: number | null;
  totalCount:  number;
  tab:         Tab;
}) {
  const fps    = useFPS();
  const mounts = getMountCount();

  return (
    <View style={M.overlay} pointerEvents="none">
      <Text style={M.line}>FPS: <Text style={M.val}>{fps}</Text></Text>
      {tab === 'cv' && renderCount !== null && (
        <Text style={M.line}>
          Rendered: <Text style={M.val}>{renderCount}/{totalCount}</Text>
        </Text>
      )}
      <Text style={M.line}>Mounts: <Text style={M.val}>{mounts}</Text></Text>
    </View>
  );
}

const M = StyleSheet.create({
  overlay: { position: 'absolute', top: 8, right: 8, backgroundColor: '#000a',
             borderRadius: 8, padding: 8, minWidth: 130, zIndex: 100 },
  line:    { fontSize: 11, color: '#94a3b8', fontFamily: 'Menlo' },
  val:     { color: '#4ade80' },
});

// ─── List implementations ─────────────────────────────────────────────────────

function CVList({ onRenderCountChange }: { onRenderCountChange: (n: number, t: number) => void }) {
  return (
    <CollectionView
      data={DATA}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => <ComparisonCell item={item} />}
      itemHeight={ITEM_H}
      itemSpacing={1}
      renderMultiplier={1.0}
      onRenderCountChange={onRenderCountChange}
    />
  );
}

function FlashListImpl() {
  return (
    <FlashList
      data={DATA}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => <ComparisonCell item={item} />}
      estimatedItemSize={ITEM_H}
    />
  );
}

function FlatListImpl() {
  return (
    <FlatList
      data={DATA}
      keyExtractor={item => String(item.id)}
      renderItem={({ item }) => <ComparisonCell item={item} />}
      getItemLayout={(_, index) => ({
        length: ITEM_H, offset: ITEM_H * index, index,
      })}
      removeClippedSubviews
    />
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function Comparison() {
  const [activeTab,    setActiveTab]    = useState<Tab>('cv');
  const [renderCount,  setRenderCount]  = useState<number | null>(null);

  const handleTabPress = useCallback((tab: Tab) => {
    resetMountCount();
    setRenderCount(null);
    setActiveTab(tab);
  }, []);

  const handleRenderCountChange = useCallback((n: number, t: number) => {
    setRenderCount(n);
  }, []);

  return (
    <SafeAreaView style={S.root}>
      {/* Tab bar */}
      <View style={S.tabBar}>
        {TABS.map(t => (
          <Pressable
            key={t.id}
            style={[S.tab, activeTab === t.id && S.tabActive]}
            onPress={() => handleTabPress(t.id)}
          >
            <Text style={[S.tabText, activeTab === t.id && S.tabTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Subtitle */}
      <View style={S.subtitle}>
        <Text style={S.subtitleText}>
          {ITEM_COUNT} items · {ITEM_H}px · local like state · mount counter
        </Text>
        <Text style={S.subtitleHint}>
          {activeTab === 'flash'
            ? 'Scroll fast → watch like state bleed (recycling artifact)'
            : activeTab === 'flat'
            ? 'All items mounted at once — watch mount count'
            : 'No recycling — like state always correct · C++ layout + window controller'}
        </Text>
      </View>

      {/* List area */}
      <View style={S.listArea}>
        <MetricsOverlay
          renderCount={renderCount}
          totalCount={ITEM_COUNT}
          tab={activeTab}
        />

        {activeTab === 'cv'    && <CVList        onRenderCountChange={handleRenderCountChange} />}
        {activeTab === 'flash' && <FlashListImpl />}
        {activeTab === 'flat'  && <FlatListImpl  />}
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0a0a0a' },

  tabBar:       { flexDirection: 'row', paddingHorizontal: 12,
                  paddingTop: 8, paddingBottom: 4, gap: 8 },
  tab:          { flex: 1, paddingVertical: 7, borderRadius: 8,
                  backgroundColor: '#1a1a1a', alignItems: 'center' },
  tabActive:    { backgroundColor: '#1e3a1e' },
  tabText:      { fontSize: 12, fontWeight: '600', color: '#555' },
  tabTextActive:{ color: '#4ade80' },

  subtitle:     { paddingHorizontal: 16, paddingVertical: 6,
                  borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  subtitleText: { fontSize: 11, color: '#555' },
  subtitleHint: { fontSize: 11, color: '#4a5568', marginTop: 2 },

  listArea:     { flex: 1 },
});
