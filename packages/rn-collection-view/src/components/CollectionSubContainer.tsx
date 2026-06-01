/**
 * CollectionSubContainer — generic JS host for a single section that owns its
 * own layout (orthogonal, radial, spiral, carousel3D, hex, user-defined).
 *
 * Composition model:
 *   <CollectionSubContainer
 *     layout={radial({ radius: 150, itemSize: 80 })}
 *     data={items}
 *     renderItem={...}
 *     layoutCacheId={cacheId}     // shared with parent CollectionView
 *     sectionIndex={2}            // slice of the cache this owns
 *   />
 *
 * What the component does:
 *   - Calls `layout.prepare(ctx)` on mount, viewport size change, or data change.
 *   - For scroll-driven layouts: forwards onSubScroll → `layout.processScroll(...)`,
 *     which writes new attributes to the cache via `setAttributesBatch`. The
 *     C++ ShadowNode picks them up on its next layout pass and the iOS view
 *     applies the new frames + transforms + opacity natively (no JS work in
 *     the apply path).
 *   - Mounts each data item inside an RNMeasuredCell. Cells receive NO absolute
 *     positioning — their frames come from the sub-container ShadowNode.
 *
 * The scrollDirection is derived from the layout (`horizontal: true` →
 * 'horizontal'; `horizontal: false` → 'vertical'). Pass `scrollDirection="none"`
 * explicitly for static layouts (e.g. hex tiling that fits in the viewport).
 */

import * as React from 'react';
import { View, type LayoutChangeEvent, type NativeSyntheticEvent } from 'react-native';

import RNCollectionSubContainer from '../specs/RNCollectionSubContainerNativeComponent';
import RNMeasuredCell from '../specs/RNMeasuredCellNativeComponent';
import NativeCollectionViewModule from '../specs/NativeCollectionViewModule';
import type {
  RiffLayout,
  LayoutContext,
  SectionInfo,
} from '../types/protocol';

const nativeMod = NativeCollectionViewModule as unknown as {
  layoutCacheId: number;
  layoutCache: {
    setAttributesBatch?(batch: object[]): void;
    setAttributes(attrs: object): void;
    version(): number;
  };
};

type ScrollDirection = 'vertical' | 'horizontal' | 'none';

export interface CollectionSubContainerProps<T> {
  /** Layout engine for this section. Must implement RiffLayout. */
  layout: RiffLayout;

  /** Data items for this section. */
  data: T[];

  /** Render function for a single item. Cells get no absolute styles. */
  renderItem: (info: { item: T; index: number; section: number }) => React.ReactElement;

  /** Stable identity for each item. Defaults to index-based string. */
  keyExtractor?: (item: T, index: number) => string;

  /** Cache ID — must match the parent CollectionView's. Defaults to nativeMod.layoutCacheId. */
  layoutCacheId?: number;

  /** Section index this sub-container owns within the parent cache. */
  sectionIndex: number;

  /**
   * Override scroll direction. Defaults to derive-from-layout:
   *   layout.horizontal === true  → 'horizontal'
   *   layout.horizontal === false → 'vertical'
   * Pass 'none' for static layouts that don't need scrolling.
   */
  scrollDirection?: ScrollDirection;

  /** Optional fixed cross-axis size hint (height for H, width for V). */
  crossAxisSize?: number;

  /** Style passed through to the outer wrapper. */
  style?: object;
}

/**
 * Cells live inside the native sub-container; positions are applied natively.
 * Wrap each rendered item in RNMeasuredCell so:
 *   1. The cell carries a stable cacheKey for ShadowNode lookup
 *   2. Yoga measures intrinsic size when the layout is content-determined
 *      (list, grid with variable height, etc.)
 */
function CollectionSubContainerInner<T>({
  layout,
  data,
  renderItem,
  keyExtractor,
  layoutCacheId,
  sectionIndex,
  scrollDirection,
  crossAxisSize,
  style,
}: CollectionSubContainerProps<T>) {
  const cacheId = layoutCacheId ?? nativeMod.layoutCacheId;

  // ── Container width is needed to call layout.prepare() with a real context ──
  const [containerSize, setContainerSize] = React.useState<{ w: number; h: number }>({
    w: 0,
    h: crossAxisSize ?? 0,
  });

  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setContainerSize(prev => {
      if (Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5) return prev;
      return { w: width, h: height };
    });
  }, []);

  // ── Resolve item keys (used for cell mounting + as cacheKey identity) ──
  const itemKeys = React.useMemo(
    () => data.map((item, i) => (keyExtractor ? keyExtractor(item, i) : `sub-${sectionIndex}-${i}`)),
    [data, keyExtractor, sectionIndex],
  );

  // ── Build LayoutContext for prepare()/processScroll() calls ──
  const layoutCtxRef = React.useRef<LayoutContext | null>(null);
  React.useMemo(() => {
    if (containerSize.w <= 0) return;
    const sectionInfo: SectionInfo = {
      itemCount: data.length,
      supplementaryItems: [],
      itemKeys,
    };
    layoutCtxRef.current = {
      containerWidth:  containerSize.w,
      containerHeight: containerSize.h,
      scrollOffset:    { x: 0, y: 0 },
      sections:        [sectionInfo],
    };
  }, [containerSize.w, containerSize.h, data.length, itemKeys]);

  // ── Run prepare() whenever inputs change ──
  // Layout writes attributes into the cache; the C++ ShadowNode reads them
  // on its next layout pass and packs them into ChildVisualState entries.
  React.useEffect(() => {
    const ctx = layoutCtxRef.current;
    if (!ctx) return;
    layout.prepare(ctx);
  }, [layout, containerSize.w, containerSize.h, data.length, itemKeys]);

  // ── Scroll handler ──
  // Forward to layout.processScroll if defined. The layout writes new
  // attributes into the cache via setAttributesBatch; the C++ ShadowNode
  // re-reads on its next state update; iOS native view applies frames +
  // transforms in one shot.
  const handleScroll = React.useCallback(
    (e: NativeSyntheticEvent<{ sectionIndex: number; scrollX: number; scrollY: number }>) => {
      if (!layout.processScroll) return;
      const ctx = layoutCtxRef.current;
      if (!ctx) return;
      const { scrollX, scrollY } = e.nativeEvent;
      // Update ctx with current offset for the layout's reference.
      const updatedCtx: LayoutContext = {
        ...ctx,
        scrollOffset: { x: scrollX, y: scrollY },
      };
      layoutCtxRef.current = updatedCtx;
      layout.processScroll({ x: scrollX, y: scrollY }, updatedCtx);
    },
    [layout],
  );

  // ── Resolve scroll direction ──
  const dir: ScrollDirection =
    scrollDirection ?? (layout.horizontal ? 'horizontal' : 'vertical');

  // ── Content size for the native ScrollView ──
  // Read from layout.contentSize() — single source of truth.
  const contentSize = React.useMemo(() => {
    if (containerSize.w <= 0) return { width: 0, height: 0 };
    try {
      return layout.contentSize();
    } catch {
      return { width: 0, height: 0 };
    }
  }, [layout, containerSize.w, containerSize.h, data.length]);

  return (
    <View onLayout={onLayout} style={style}>
      <RNCollectionSubContainer
        layoutCacheId={cacheId}
        sectionIndex={sectionIndex}
        scrollDirection={dir}
        contentWidth={contentSize.width}
        contentHeight={contentSize.height}
        onSubScroll={handleScroll}
        style={{ flex: 1 }}>
        {data.map((item, i) => {
          const key = itemKeys[i];
          return (
            <RNMeasuredCell
              key={key}
              cacheKey={key}
              type="cell"
              index={i}>
              {renderItem({ item, index: i, section: sectionIndex })}
            </RNMeasuredCell>
          );
        })}
      </RNCollectionSubContainer>
    </View>
  );
}

// Generics-friendly export.
export const CollectionSubContainer = React.memo(CollectionSubContainerInner) as <T>(
  props: CollectionSubContainerProps<T>,
) => React.ReactElement;
