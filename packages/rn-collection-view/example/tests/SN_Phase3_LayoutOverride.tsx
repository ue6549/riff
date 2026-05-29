/**
 * ShadowNode Phase 3 — Layout Override verification.
 *
 * Renders <RNCollectionViewContainer> with children that have VARYING heights.
 * Children DO NOT set their own `top` position — the ShadowNode computes
 * correct Y positions from Yoga-measured heights and the native view applies them.
 *
 * 4 positioning modes (tabs) to test different native override strategies:
 *   0 = Frame origin (layoutSubviews only)
 *   1 = Center (layoutSubviews only)
 *   2 = Transform (layoutSubviews only)
 *   3 = Frame origin multi-hook (mount + updateState + finalize + layoutSubviews)
 */
import React, {useState} from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import RNCollectionViewContainer from '@riff/specs/RNCollectionViewContainerNativeComponent';

const COLORS = [
  '#e63946',
  '#2a9d8f',
  '#e9c46a',
  '#f4a261',
  '#264653',
  '#457b9d',
];

// Variable heights — the whole point of the test.
const ITEM_HEIGHTS = [
  60, 40, 100, 80, 120, 55, 90, 160, 45, 70, 110, 50, 130, 65, 85, 140, 48,
  95, 75, 105, 60, 40, 100, 80, 120, 55, 90, 160, 45, 70,
];

const ROW_SPACING = 8;
const INSET_LEFT = 8;
const INSET_RIGHT = 8;
const INSET_TOP = 8;

const EXPECTED_TOTAL =
  INSET_TOP +
  ITEM_HEIGHTS.reduce((sum, h) => sum + h, 0) +
  (ITEM_HEIGHTS.length - 1) * ROW_SPACING;

const MODES = [
  {id: 0, label: 'Frame', desc: 'frame.origin in layoutSubviews'},
  {id: 1, label: 'Center', desc: 'center in layoutSubviews'},
  {id: 2, label: 'Transform', desc: 'CGAffineTransform in layoutSubviews'},
  {id: 3, label: 'Multi', desc: 'frame.origin from mount+state+finalize+layout'},
];

export default function SNPhase3LayoutOverride() {
  const [mode, setMode] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [scrollCount, setScrollCount] = useState(0);

  const children = ITEM_HEIGHTS.map((h, i) => (
    <View
      key={i}
      collapsable={false}
      style={[
        S.item,
        {
          height: h,
          backgroundColor: COLORS[i % COLORS.length],
        },
      ]}>
      <Text style={S.itemText}>
        Item {i} — {h}px
      </Text>
      <Text style={S.itemSub}>
        Mode {mode}: {MODES[mode].desc}
      </Text>
    </View>
  ));

  return (
    <View style={S.root}>
      <View style={S.header}>
        <Text style={S.title}>Phase 3 — Positioning Modes</Text>

        {/* Mode tabs */}
        <View style={S.tabs}>
          {MODES.map(m => (
            <TouchableOpacity
              key={m.id}
              style={[S.tab, mode === m.id && S.tabActive]}
              onPress={() => {
                setMode(m.id);
                setScrollY(0);
                setScrollCount(0);
              }}>
              <Text style={[S.tabText, mode === m.id && S.tabTextActive]}>
                {m.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={S.metric}>
          Mode {mode}: {MODES[mode].desc}
        </Text>
        <Text style={S.metric}>ScrollY: {scrollY.toFixed(0)} | Events: {scrollCount}</Text>
        <Text style={S.metric}>
          Expected height: {EXPECTED_TOTAL}px
        </Text>
      </View>

      <RNCollectionViewContainer
        key={`mode-${mode}`}
        style={S.container}
        rowSpacing={ROW_SPACING}
        sectionInsetTop={INSET_TOP}
        sectionInsetLeft={INSET_LEFT}
        sectionInsetRight={INSET_RIGHT}
        scrollEventThrottle={16}
        bounces={true}
        onScroll={(e: any) => {
          const y = e.nativeEvent.contentOffset.y;
          setScrollY(y);
          setScrollCount(c => c + 1);
        }}>
        {children}
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
  tabs: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 6,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#222',
  },
  tabActive: {
    backgroundColor: '#3b82f6',
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  tabTextActive: {
    color: '#fff',
  },
  metric: {
    fontSize: 11,
    color: '#94a3b8',
    fontFamily: 'Menlo',
    marginTop: 4,
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
