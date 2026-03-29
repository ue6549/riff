/**
 * Grid Layout — fixed columns, row-aligned heights.
 *
 * Backed by the C++ GridLayout engine via JSI.
 * Items placed left-to-right in rows. Each row's height = tallest item in that row
 * (or estimated `rowHeight` if provided — actual height determined by Yoga).
 *
 * Width per item = (containerWidth - insets - spacing) / columns.
 *
 * The C++ engine writes LayoutAttributes to the shared LayoutCache.
 * This JS wrapper delegates all spatial queries to the LayoutCache so the
 * ShadowNode's measurement corrections are immediately visible to JS.
 */

import type {
  CollectionViewLayout,
  LayoutContext,
  GridLayoutDelegate,
  InvalidationScope,
} from '../types/protocol';
import type { LayoutAttributes, Rect, Size } from '../types';
import NativeCollectionViewModule from '../specs/NativeCollectionViewModule';

const nativeMod = NativeCollectionViewModule as unknown as {
  layoutCache: {
    getAttributesInRect(rect: { x: number; y: number; width: number; height: number }): LayoutAttributes[];
    getAttributes(key: string): LayoutAttributes | null;
    getTotalContentSize(): Size;
    clear(): void;
  };
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
      itemHeights?: number[];
      keys: string[];
    }): { positions: number[]; contentHeight: number };
  };
};

class GridLayoutEngine implements CollectionViewLayout {
  readonly type = 'grid';
  private readonly delegate: GridLayoutDelegate;

  constructor(delegate: GridLayoutDelegate) {
    this.delegate = delegate;
  }

  prepare(context: LayoutContext): void {
    const d = this.delegate;

    const sec = context.sections[0];
    if (!sec || sec.itemCount === 0 || context.containerWidth <= 0) {
      return;
    }

    const w = context.containerWidth;
    const effectiveColumns = typeof d.columns === 'function' ? d.columns(w) : d.columns;
    const effectiveRowHeight = typeof d.rowHeight === 'function' ? d.rowHeight(w) : d.rowHeight;

    // Build per-item heights if dynamic.
    // Priority: measured (actual) → delegate heightForItem (estimate).
    let itemHeights: number[] | undefined;
    if (!effectiveRowHeight && (d.heightForItem || context.measuredHeightForItem)) {
      itemHeights = new Array(sec.itemCount);
      for (let i = 0; i < sec.itemCount; i++) {
        const measured = context.measuredHeightForItem?.(i, 0);
        itemHeights[i] = measured ?? (d.heightForItem ? d.heightForItem(i, 0, w) : 0);
      }
    }

    // Build keys array
    const keys: string[] = new Array(sec.itemCount);
    for (let i = 0; i < sec.itemCount; i++) {
      keys[i] = `grid-${i}`;
    }

    // C++ engine computes layout and writes to shared LayoutCache.
    // We discard the JS return value — all queries go through the cache
    // so ShadowNode measurement corrections are immediately visible.
    nativeMod.gridLayout.computeGridLayout({
      itemCount: sec.itemCount,
      columns: effectiveColumns,
      columnSpacing: d.columnSpacing ?? 0,
      rowSpacing: d.rowSpacing ?? 0,
      viewportWidth: w,
      rowHeight: effectiveRowHeight ?? 0,
      sectionInsetTop: sec.insets?.top ?? 0,
      sectionInsetBottom: sec.insets?.bottom ?? 0,
      sectionInsetLeft: sec.insets?.left ?? 0,
      sectionInsetRight: sec.insets?.right ?? 0,
      ...(itemHeights ? { itemHeights } : {}),
      keys,
    });
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    return nativeMod.layoutCache.getAttributesInRect(inRect);
  }

  attributesForItem(index: number, _section: number): LayoutAttributes | null {
    return nativeMod.layoutCache.getAttributes(`grid-${index}`);
  }

  attributesForSupplementary(_kind: string, _section: number): LayoutAttributes | null {
    return null;
  }

  contentSize(): Size {
    return nativeMod.layoutCache.getTotalContentSize();
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    return Math.abs(oldBounds.width - newBounds.width) > 0.5;
  }

  invalidationScope(): InvalidationScope {
    return { type: 'full' };
  }
}

/**
 * Create a grid layout with the given delegate configuration.
 *
 * ```typescript
 * // Estimated row height (actual determined by Yoga measurement)
 * layout={grid({ columns: 3, rowHeight: 100, columnSpacing: 8, rowSpacing: 8 })}
 *
 * // Dynamic per-item height estimate (tallest in row wins)
 * layout={grid({ columns: 3, heightForItem: (i) => heights[i], columnSpacing: 8 })}
 * ```
 */
export function grid(delegate: GridLayoutDelegate): CollectionViewLayout {
  return new GridLayoutEngine(delegate);
}
