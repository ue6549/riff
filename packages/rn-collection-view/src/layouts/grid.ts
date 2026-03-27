/**
 * Grid Layout — fixed columns, row-aligned heights.
 *
 * Backed by the C++ GridLayout engine via JSI.
 * Items placed left-to-right in rows. Each row's height = tallest item in that row
 * (or fixed `rowHeight` if provided).
 *
 * Width per item = (containerWidth - insets - spacing) / columns.
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
  private _contentHeight = 0;
  private _positions: number[] = [];
  private _containerWidth = 0;

  constructor(delegate: GridLayoutDelegate) {
    this.delegate = delegate;
  }

  prepare(context: LayoutContext): void {
    const d = this.delegate;
    this._containerWidth = context.containerWidth;

    const sec = context.sections[0];
    if (!sec || sec.itemCount === 0 || context.containerWidth <= 0) {
      this._contentHeight = 0;
      this._positions = [];
      return;
    }

    const w = context.containerWidth;
    const effectiveColumns = typeof d.columns === 'function' ? d.columns(w) : d.columns;
    const effectiveRowHeight = typeof d.rowHeight === 'function' ? d.rowHeight(w) : d.rowHeight;

    // Build per-item heights if dynamic
    let itemHeights: number[] | undefined;
    if (!effectiveRowHeight && d.heightForItem) {
      itemHeights = new Array(sec.itemCount);
      for (let i = 0; i < sec.itemCount; i++) {
        itemHeights[i] = d.heightForItem(i, 0, w);
      }
    }

    // Build keys array
    const keys: string[] = new Array(sec.itemCount);
    for (let i = 0; i < sec.itemCount; i++) {
      keys[i] = `grid-${i}`;
    }

    const result = nativeMod.gridLayout.computeGridLayout({
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

    this._positions = result.positions;
    this._contentHeight = result.contentHeight;
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    const result: LayoutAttributes[] = [];
    const pos = this._positions;
    const n = pos.length / 4;

    for (let i = 0; i < n; i++) {
      const x = pos[i * 4]!;
      const y = pos[i * 4 + 1]!;
      const w = pos[i * 4 + 2]!;
      const h = pos[i * 4 + 3]!;

      if (y + h < inRect.y || y > inRect.y + inRect.height) continue;
      if (x + w < inRect.x || x > inRect.x + inRect.width) continue;

      result.push({
        key: `grid-${i}`,
        section: 0,
        index: i,
        frame: { x, y, width: w, height: h },
        zIndex: 0,
        isSupplementary: false,
        supplementaryKind: null,
        sizingState: 'measured',
        isDirty: false,
        tier: 'visible',
        isSticky: false,
        alpha: 1,
        isAnimating: false,
      });
    }

    return result;
  }

  attributesForItem(index: number, _section: number): LayoutAttributes | null {
    const pos = this._positions;
    if (index < 0 || index >= pos.length / 4) return null;

    return {
      key: `grid-${index}`,
      section: 0,
      index,
      frame: {
        x: pos[index * 4]!,
        y: pos[index * 4 + 1]!,
        width: pos[index * 4 + 2]!,
        height: pos[index * 4 + 3]!,
      },
      zIndex: 0,
      isSupplementary: false,
      supplementaryKind: null,
      sizingState: 'measured',
      isDirty: false,
      tier: 'visible',
      isSticky: false,
      alpha: 1,
      isAnimating: false,
    };
  }

  attributesForSupplementary(_kind: string, _section: number): LayoutAttributes | null {
    return null;
  }

  contentSize(): Size {
    return { width: this._containerWidth, height: this._contentHeight };
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
 * // Fixed row height
 * layout={grid({ columns: 3, rowHeight: 100, columnSpacing: 8, rowSpacing: 8 })}
 *
 * // Dynamic row height (tallest in row wins)
 * layout={grid({ columns: 3, heightForItem: (i) => heights[i], columnSpacing: 8 })}
 * ```
 */
export function grid(delegate: GridLayoutDelegate): CollectionViewLayout {
  return new GridLayoutEngine(delegate);
}
