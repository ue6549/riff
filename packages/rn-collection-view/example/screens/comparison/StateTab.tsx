/**
 * Tab 6 — State Bleed (soft demo)
 *
 * Like buttons with local useState. FlashList recycles = state on wrong items.
 * CollectionView = identity-preserving, always correct.
 *
 * Honest framing: manageable in FlashList by lifting state, but default differs.
 */
import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Riff } from '../../components/CollectionView';
import {
  ComparisonCell,
  getMountCount,
  makeComparisonData,
  resetMountCount,
} from '../../components/ComparisonCell';
import { useFPS } from '../../utils/useMetrics';

const ITEM_COUNT = 500;
const ITEM_H = 88;
const DATA = makeComparisonData(ITEM_COUNT);

function Metrics({ renderCount }: { renderCount: number | null }) {
  const fps = useFPS();
  const mounts = getMountCount();
  return (
    <View style={S.overlay} pointerEvents="none">
      <Text style={S.metricLine}>FPS: <Text style={S.metricVal}>{fps}</Text></Text>
      {renderCount !== null && (
        <Text style={S.metricLine}>Rendered: <Text style={S.metricVal}>{renderCount}/{ITEM_COUNT}</Text></Text>
      )}
      <Text style={S.metricLine}>Mounts: <Text style={S.metricVal}>{mounts}</Text></Text>
    </View>
  );
}

export default function StateTab({ mode }: { mode: 'cv' | 'flash' }) {
  const [renderCount, setRenderCount] = React.useState<number | null>(null);

  React.useEffect(() => { resetMountCount(); }, [mode]);

  return (
    <View style={S.root}>
      <Text style={S.hint}>
        {mode === 'cv'
          ? 'No recycling — like state always correct · C++ window controller'
          : 'Scroll fast → watch like state bleed to wrong items (recycling)'}
      </Text>
      <View style={S.listArea}>
        <Metrics renderCount={mode === 'cv' ? renderCount : null} />
        {mode === 'cv' ? (
          <Riff
            data={DATA}
            keyExtractor={item => String(item.id)}
            renderItem={({ item }) => <ComparisonCell item={item} />}
            itemHeight={ITEM_H}
            itemSpacing={1}
            onRenderCountChange={(n) => setRenderCount(n)}
          />
        ) : (
          <FlashList
            data={DATA}
            keyExtractor={item => String(item.id)}
            renderItem={({ item }) => <ComparisonCell item={item} />}
            estimatedItemSize={ITEM_H}
          />
        )}
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  hint: { fontSize: 11, color: '#4a5568', paddingHorizontal: 12, paddingVertical: 6 },
  listArea: { flex: 1 },
  overlay: { position: 'absolute', top: 8, right: 8, backgroundColor: '#000a',
             borderRadius: 8, padding: 8, minWidth: 130, zIndex: 100 },
  metricLine: { fontSize: 11, color: '#94a3b8', fontFamily: 'Menlo' },
  metricVal: { color: '#4ade80' },
});
