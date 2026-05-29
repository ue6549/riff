/**
 * ShadowNode Phase 1 — Skeleton verification.
 *
 * Renders <RNCollectionViewContainer> with colored child views.
 * Verifies:
 *   1. Component mounts without crash
 *   2. Children are visible inside the scroll container
 *   3. Scrolling works (content extends beyond viewport)
 *   4. onScroll events arrive in JS
 *   5. State updates (content size) flow from ShadowNode to native view
 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import RNCollectionViewContainer from '@riff/specs/RNCollectionViewContainerNativeComponent';

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#f4a261', '#264653', '#457b9d'];
const ITEM_COUNT = 30;
const ITEM_HEIGHT = 80;

export default function SNPhase1Skeleton() {
  const [scrollY, setScrollY] = useState(0);
  const [scrollCount, setScrollCount] = useState(0);

  const children = Array.from({ length: ITEM_COUNT }, (_, i) => (
    <View
      key={i}
      collapsable={false}
      style={[
        S.item,
        {
          backgroundColor: COLORS[i % COLORS.length],
          top: i * (ITEM_HEIGHT + 8),
        },
      ]}
    >
      <Text style={S.itemText}>Item {i}</Text>
      <Text style={S.itemSub}>{ITEM_HEIGHT}px · position: absolute top={i * (ITEM_HEIGHT + 8)}</Text>
    </View>
  ));

  return (
    <View style={S.root}>
      <View style={S.header}>
        <Text style={S.title}>ShadowNode Phase 1 — Skeleton</Text>
        <Text style={S.metric}>ScrollY: {scrollY.toFixed(0)}</Text>
        <Text style={S.metric}>Scroll events: {scrollCount}</Text>
        <Text style={S.check}>
          {scrollCount > 0 ? '  Scrolling works' : '  Scroll to verify'}
        </Text>
      </View>

      <RNCollectionViewContainer
        style={S.container}
        estimatedItemHeight={ITEM_HEIGHT}
        rowSpacing={8}
        sectionInsetTop={8}
        sectionInsetBottom={8}
        sectionInsetLeft={8}
        sectionInsetRight={8}
        scrollEventThrottle={16}
        bounces={true}
        onScroll={(e: any) => {
          const y = e.nativeEvent.contentOffset.y;
          setScrollY(y);
          setScrollCount(c => c + 1);
        }}
      >
        {children}
      </RNCollectionViewContainer>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    padding: 12,
    backgroundColor: '#111',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  title: { fontSize: 14, fontWeight: '700', color: '#e2e8f0' },
  metric: { fontSize: 12, color: '#94a3b8', fontFamily: 'Menlo', marginTop: 4 },
  check: { fontSize: 12, marginTop: 4 },
  container: { flex: 1 },
  item: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: ITEM_HEIGHT,
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  itemText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  itemSub: { fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 4 },
});
