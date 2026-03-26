/**
 * CollectionView — M2.1 shell + M2.3 non-virtualized renderer.
 *
 * Renders all items absolutely positioned from the C++ layout cache.
 * No windowing yet — that comes in M2.4 with the C++ window controller.
 *
 * Scroll container is fully pluggable via three layers (§4.2):
 *   1. scrollViewProps   — forward extra props to the default ScrollView
 *   2. ScrollViewComponent — swap the component class entirely
 *   3. renderScrollView  — full render control (render prop)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  ScrollView,
  ScrollViewProps,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';

import NativeCollectionViewModule from './specs/NativeCollectionViewModule';
import { layoutCache } from './LayoutCache';

// listLayout is installed as a JSI property at runtime — not in the codegen spec.
const nativeListLayout = (NativeCollectionViewModule as unknown as {
  listLayout: { computeListLayout(params: object): void };
}).listLayout;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RenderItemInfo<T> {
  item: T;
  index: number;
}

export interface CollectionViewProps<T = unknown> {
  /** Item data array. */
  data: T[];

  /** Renders a single cell. Must be pure / stable. */
  renderItem: (info: RenderItemInfo<T>) => React.ReactElement | null;

  /** Stable key for each item. Defaults to String(index). */
  keyExtractor?: (item: T, index: number) => string;

  // ── Layout ──────────────────────────────────────────────────────────────
  /** Fixed item height (points). Estimated / self-sizing: future milestone. */
  itemHeight: number;
  /** Vertical gap between items. */
  itemSpacing?: number;
  sectionInsetTop?: number;
  sectionInsetBottom?: number;
  sectionInsetLeft?: number;
  sectionInsetRight?: number;

  // ── Scroll container customisation (§4.2) ───────────────────────────────
  /**
   * Layer 1 — extra props forwarded to the default ScrollView.
   * Consumer's event handlers (onScroll, onMomentumScrollEnd, …) are called
   * after CollectionView's own bookkeeping.
   */
  scrollViewProps?: ScrollViewProps;

  /**
   * Layer 2 — replace the ScrollView component class.
   * The component must accept standard ScrollViewProps.
   * Example: `ScrollViewComponent={Animated.ScrollView}`
   */
  ScrollViewComponent?: React.ComponentType<ScrollViewProps>;

  /**
   * Layer 3 — full render control.
   * Receives all contract props (including children) and must render them.
   * Example: `renderScrollView={(p) => <Animated.ScrollView {...p} />}`
   * Takes precedence over ScrollViewComponent when both are provided.
   */
  renderScrollView?: (
    props: ScrollViewProps & { children: React.ReactNode },
  ) => React.ReactElement;

  style?: StyleProp<ViewStyle>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CollectionView<T = unknown>({
  data,
  renderItem,
  keyExtractor,
  itemHeight,
  itemSpacing = 0,
  sectionInsetTop = 0,
  sectionInsetBottom = 0,
  sectionInsetLeft = 0,
  sectionInsetRight = 0,
  ScrollViewComponent,
  scrollViewProps,
  renderScrollView,
  style,
}: CollectionViewProps<T>) {
  // Viewport width drives the C++ layout computation.
  // A ref avoids stale-closure issues in the onLayout callback.
  const viewportWidthRef = useRef(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);

  const itemCount = data.length;

  // ── Layout pass ───────────────────────────────────────────────────────────
  // Re-runs whenever dimensions or list shape changes.
  // Populates the C++ LayoutCache so the window controller (M2.4) can read it.
  useEffect(() => {
    if (viewportWidth === 0) return;

    layoutCache.clear();

    if (itemCount === 0) {
      setContentHeight(sectionInsetTop + sectionInsetBottom);
      return;
    }

    nativeListLayout.computeListLayout({
      itemCount,
      itemHeight,
      viewportWidth,
      sectionInsetTop,
      sectionInsetBottom,
      sectionInsetLeft,
      sectionInsetRight,
      itemSpacing,
      section: 0,
      keyPrefix: 'cv-item-0-',
    });

    setContentHeight(layoutCache.getTotalContentSize().height);
  }, [
    viewportWidth,
    itemCount,
    itemHeight,
    itemSpacing,
    sectionInsetTop,
    sectionInsetBottom,
    sectionInsetLeft,
    sectionInsetRight,
  ]);

  // ── Viewport measurement ──────────────────────────────────────────────────
  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== viewportWidthRef.current) {
      viewportWidthRef.current = w;
      setViewportWidth(w);
    }
  }, []);

  // ── Item rendering ────────────────────────────────────────────────────────
  // Positions computed directly (fixed-height formula) — avoids getAll()
  // JSI marshalling overhead (O(n), ~24ms for 10k items).
  // M2.4 window controller will take over tier management.
  const stride    = itemHeight + itemSpacing;
  const itemWidth = Math.max(0, viewportWidth - sectionInsetLeft - sectionInsetRight);

  const scrollContent = (
    <View style={{ height: contentHeight }}>
      {viewportWidth > 0 &&
        data.map((item, index) => {
          const key = keyExtractor ? keyExtractor(item, index) : String(index);
          return (
            <View
              key={key}
              style={{
                position: 'absolute',
                left: sectionInsetLeft,
                top: sectionInsetTop + index * stride,
                width: itemWidth,
                height: itemHeight,
              }}
            >
              {renderItem({ item, index })}
            </View>
          );
        })}
    </View>
  );

  // ── Contract props injected into whichever scroll container is used ───────
  const contractProps: ScrollViewProps = {
    scrollEventThrottle: 16,
    ...scrollViewProps,
  };

  // ── Scroll container selection (layer 3 > layer 2 > default) ─────────────
  if (renderScrollView) {
    return (
      <View style={[{ flex: 1 }, style]} onLayout={onContainerLayout}>
        {renderScrollView({ ...contractProps, children: scrollContent })}
      </View>
    );
  }

  const Scroll = (ScrollViewComponent ?? ScrollView) as React.ComponentType<ScrollViewProps>;
  return (
    <View style={[{ flex: 1 }, style]} onLayout={onContainerLayout}>
      <Scroll style={{ flex: 1 }} {...contractProps}>
        {scrollContent}
      </Scroll>
    </View>
  );
}
