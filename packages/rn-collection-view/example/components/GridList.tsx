/**
 * GridList — Lightweight grid component powered by C++ GridLayout.
 *
 * Used in the FlashList comparison demo (resize tab). Not a full CollectionView —
 * just enough windowing to demonstrate grid with virtualization.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import NativeCollectionViewModule from './NativeCollectionViewModule';

const nativeMod = NativeCollectionViewModule as unknown as {
  gridLayout: {
    computeGridLayout(params: {
      itemCount: number;
      columns: number;
      columnSpacing: number;
      rowSpacing: number;
      viewportWidth: number;
      rowHeight: number;
      sectionInsetTop?: number;
      sectionInsetBottom?: number;
      sectionInsetLeft?: number;
      sectionInsetRight?: number;
      keys: string[];
    }): { positions: number[]; contentHeight: number };
  };
};

interface GridListProps<T> {
  data: T[];
  /** Fixed column count, or a function that derives columns from container width. */
  columns?: number | ((containerWidth: number) => number);
  columnSpacing?: number;
  rowSpacing?: number;
  rowHeight: number;
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: { item: T; index: number; width: number }) => React.ReactElement;
  renderMultiplier?: number;
  insets?: { top?: number; bottom?: number; left?: number; right?: number };
}

export function GridList<T>({
  data,
  columns = 2,
  columnSpacing = 8,
  rowSpacing = 8,
  rowHeight,
  keyExtractor,
  renderItem,
  renderMultiplier = 2.0,
  insets,
}: GridListProps<T>) {
  const [vpWidth, setVpWidth] = useState(0);
  const [vpHeight, setVpHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);

  const effectiveColumns = typeof columns === 'function' ? columns(vpWidth) : columns;

  const layout = useMemo(() => {
    if (vpWidth <= 0 || data.length === 0) return null;
    const keys = data.map((item, i) => keyExtractor(item, i));
    return nativeMod.gridLayout.computeGridLayout({
      itemCount: data.length,
      columns: effectiveColumns,
      columnSpacing,
      rowSpacing,
      viewportWidth: vpWidth,
      rowHeight,
      sectionInsetTop: insets?.top ?? 0,
      sectionInsetBottom: insets?.bottom ?? 0,
      sectionInsetLeft: insets?.left ?? 0,
      sectionInsetRight: insets?.right ?? 0,
      keys,
    });
  }, [data, effectiveColumns, columnSpacing, rowSpacing, rowHeight, vpWidth, keyExtractor, insets]);

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
    setScrollY(e.nativeEvent.contentOffset.y);
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
