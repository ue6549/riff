/**
 * MasonryList — Lightweight masonry component powered by C++ MasonryLayout.
 *
 * Used in the FlashList comparison demo (Tab 4). Not a full CollectionView —
 * just enough windowing to demonstrate masonry with virtualization.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import NativeCollectionViewModule from './NativeCollectionViewModule';

const nativeMod = NativeCollectionViewModule as unknown as {
  masonryLayout: {
    computeMasonryLayout(params: {
      itemCount: number;
      columns: number;
      columnSpacing: number;
      rowSpacing: number;
      viewportWidth: number;
      sectionInsetTop?: number;
      sectionInsetBottom?: number;
      sectionInsetLeft?: number;
      sectionInsetRight?: number;
      itemHeights: number[];
      keys: string[];
    }): { positions: number[]; contentHeight: number };
  };
};

interface MasonryListProps<T> {
  data: T[];
  columns?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  getItemHeight: (item: T, index: number) => number;
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: { item: T; index: number; width: number }) => React.ReactElement;
  renderMultiplier?: number;
  insets?: { top?: number; bottom?: number; left?: number; right?: number };
}

export function MasonryList<T>({
  data,
  columns = 2,
  columnSpacing = 8,
  rowSpacing = 8,
  getItemHeight,
  keyExtractor,
  renderItem,
  renderMultiplier = 2.0,
  insets,
}: MasonryListProps<T>) {
  const [vpWidth, setVpWidth] = useState(0);
  const [vpHeight, setVpHeight] = useState(0);
  const scrollYRef = useRef(0);
  const [scrollY, setScrollY] = useState(0);

  const layout = useMemo(() => {
    if (vpWidth <= 0 || data.length === 0) return null;
    const heights = data.map((item, i) => getItemHeight(item, i));
    const keys = data.map((item, i) => keyExtractor(item, i));
    return nativeMod.masonryLayout.computeMasonryLayout({
      itemCount: data.length,
      columns,
      columnSpacing,
      rowSpacing,
      viewportWidth: vpWidth,
      sectionInsetTop: insets?.top ?? 0,
      sectionInsetBottom: insets?.bottom ?? 0,
      sectionInsetLeft: insets?.left ?? 0,
      sectionInsetRight: insets?.right ?? 0,
      itemHeights: heights,
      keys,
    });
  }, [data, columns, columnSpacing, rowSpacing, vpWidth, getItemHeight, keyExtractor, insets]);

  const cells = useMemo(() => {
    if (!layout || vpHeight <= 0) return null;
    const pad = renderMultiplier * vpHeight;
    const topEdge = scrollY - pad;
    const bottomEdge = scrollY + vpHeight + pad;
    const pos = layout.positions;
    const elements: React.ReactElement[] = [];

    for (let i = 0; i < data.length; i++) {
      const x = pos[i * 4]!;
      const y = pos[i * 4 + 1]!;
      const w = pos[i * 4 + 2]!;
      const h = pos[i * 4 + 3]!;
      if (y + h < topEdge || y > bottomEdge) continue;
      elements.push(
        <View key={keyExtractor(data[i]!, i)} style={{ position: 'absolute', left: x, top: y, width: w, height: h }}>
          {renderItem({ item: data[i]!, index: i, width: w })}
        </View>
      );
    }
    return elements;
  }, [layout, scrollY, vpHeight, data, renderItem, keyExtractor, renderMultiplier]);

  const onScroll = useCallback((e: any) => {
    const y = e.nativeEvent.contentOffset.y;
    scrollYRef.current = y;
    setScrollY(y);
  }, []);

  const onLayout = useCallback((e: any) => {
    setVpWidth(e.nativeEvent.layout.width);
    setVpHeight(e.nativeEvent.layout.height);
  }, []);

  return (
    <ScrollView
      style={S.flex}
      onLayout={onLayout}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <View style={{ height: layout?.contentHeight ?? 0 }}>
        {cells}
      </View>
    </ScrollView>
  );
}

const S = StyleSheet.create({ flex: { flex: 1 } });
