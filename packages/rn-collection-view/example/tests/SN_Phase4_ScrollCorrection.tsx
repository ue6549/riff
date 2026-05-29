/**
 * ShadowNode Phase 4 — Scroll Offset Correction.
 *
 * Tests that when items above the viewport change (insert, remove, resize),
 * the ShadowNode computes a contentOffsetCorrectionY and the native view
 * applies it — so visible content doesn't jump.
 *
 * Controls:
 *   - Insert at top: adds a new item at index 0
 *   - Remove from top: removes item at index 0
 *   - Resize top: toggles the first item between short and tall
 *   - Toggle maintainPosition: on/off to compare both behaviors
 *
 * Scroll to the middle, then press a button. If correction works,
 * the currently visible items should not visually shift.
 */
import React, {useState, useCallback} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import RNCollectionViewContainer from '@riff/specs/RNCollectionViewContainerNativeComponent';

const COLORS = [
  '#e63946',
  '#2a9d8f',
  '#e9c46a',
  '#f4a261',
  '#264653',
  '#457b9d',
  '#6d597a',
  '#b56576',
];

type Item = {
  id: number;
  height: number;
  label: string;
};

let nextId = 0;
function makeItem(height: number, label?: string): Item {
  const id = nextId++;
  return {id, height, label: label ?? `Item ${id} (${height}px)`};
}

function makeInitialItems(): Item[] {
  const heights = [60, 80, 50, 100, 70, 90, 55, 120, 65, 85, 45, 110, 75, 95, 40, 130, 60, 80, 50, 100];
  return heights.map(h => makeItem(h));
}

const ROW_SPACING = 8;
const INSET_LEFT = 8;
const INSET_RIGHT = 8;
const INSET_TOP = 8;

export default function SNPhase4ScrollCorrection() {
  const [items, setItems] = useState<Item[]>(makeInitialItems);
  const [scrollY, setScrollY] = useState(0);
  const [correctionCount, setCorrectionCount] = useState(0);
  const [lastAction, setLastAction] = useState('(none)');

  const insertAtTop = useCallback(() => {
    setItems(prev => [makeItem(80, `INSERTED (80px)`), ...prev]);
    setLastAction('Insert at top');
    setCorrectionCount(c => c + 1);
  }, []);

  const removeFromTop = useCallback(() => {
    setItems(prev => {
      if (prev.length <= 1) return prev;
      return prev.slice(1);
    });
    setLastAction('Remove from top');
    setCorrectionCount(c => c + 1);
  }, []);

  const resizeTop = useCallback(() => {
    setItems(prev => {
      if (prev.length === 0) return prev;
      const first = prev[0];
      const newHeight = first.height === 60 ? 200 : 60;
      return [{...first, height: newHeight, label: `${first.label.split(' (')[0]} (${newHeight}px)`}, ...prev.slice(1)];
    });
    setLastAction('Resize top');
    setCorrectionCount(c => c + 1);
  }, []);

  const insertThreeAtTop = useCallback(() => {
    setItems(prev => [
      makeItem(70, 'BATCH-1 (70px)'),
      makeItem(90, 'BATCH-2 (90px)'),
      makeItem(50, 'BATCH-3 (50px)'),
      ...prev,
    ]);
    setLastAction('Insert 3 at top');
    setCorrectionCount(c => c + 1);
  }, []);

  const reset = useCallback(() => {
    nextId = 0;
    setItems(makeInitialItems());
    setLastAction('Reset');
    setCorrectionCount(0);
  }, []);

  return (
    <View style={S.root}>
      <View style={S.header}>
        <Text style={S.title}>Phase 4 — Scroll Offset Correction</Text>
        <Text style={S.subtitle}>
          Scroll to middle, then insert/remove/resize at top.{'\n'}
          Visible content should NOT jump.
        </Text>
        <Text style={S.metric}>
          Items: {items.length} | ScrollY: {scrollY.toFixed(0)} | Actions: {correctionCount}
        </Text>
        <Text style={S.metric}>Last: {lastAction}</Text>

        <View style={S.buttons}>
          <TouchableOpacity style={S.btn} onPress={insertAtTop}>
            <Text style={S.btnText}>+1 Top</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.btn} onPress={removeFromTop}>
            <Text style={S.btnText}>-1 Top</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.btn} onPress={resizeTop}>
            <Text style={S.btnText}>Resize</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.btn} onPress={insertThreeAtTop}>
            <Text style={S.btnText}>+3 Top</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[S.btn, S.btnReset]} onPress={reset}>
            <Text style={S.btnText}>Reset</Text>
          </TouchableOpacity>
        </View>
      </View>

      <RNCollectionViewContainer
        style={S.container}
        rowSpacing={ROW_SPACING}
        sectionInsetTop={INSET_TOP}
        sectionInsetLeft={INSET_LEFT}
        sectionInsetRight={INSET_RIGHT}
        scrollEventThrottle={16}
        bounces={true}
        onScroll={(e: any) => {
          setScrollY(e.nativeEvent.contentOffset.y);
        }}>
        {items.map((item, i) => (
          <View
            key={item.id}
            collapsable={false}
            style={[
              S.item,
              {
                height: item.height,
                backgroundColor: COLORS[i % COLORS.length],
              },
            ]}>
            <Text style={S.itemText}>{item.label}</Text>
            <Text style={S.itemSub}>
              key={item.id} · index={i}
            </Text>
          </View>
        ))}
      </RNCollectionViewContainer>
    </View>
  );
}

const S = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0a0a0a'},
  header: {
    padding: 12,
    backgroundColor: '#111',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  title: {fontSize: 14, fontWeight: '700', color: '#e2e8f0'},
  subtitle: {fontSize: 11, color: '#94a3b8', marginTop: 2},
  metric: {
    fontSize: 11,
    color: '#94a3b8',
    fontFamily: 'Menlo',
    marginTop: 4,
  },
  buttons: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 6,
    flexWrap: 'wrap',
  },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#3b82f6',
  },
  btnReset: {
    backgroundColor: '#666',
  },
  btnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  container: {flex: 1},
  item: {
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  itemText: {fontSize: 16, fontWeight: '700', color: '#fff'},
  itemSub: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 4,
  },
});
