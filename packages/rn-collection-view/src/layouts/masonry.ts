/**
 * Masonry Layout — fixed-column, variable-height, shortest-column placement.
 *
 * Backed by the C++ MasonryLayout engine via JSI.
 * `columns` and `heightForItem` are mandatory.
 *
 * Key difference from the old API: `heightForItem` is a per-index callback,
 * not a bulk array. The factory calls it only for items in the compute range,
 * then passes a slice to C++. This enables O(window) computation per frame
 * during container resize.
 */

import type {
  CollectionViewLayout,
  LayoutContext,
  MasonryLayoutDelegate,
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

class MasonryLayoutEngine implements CollectionViewLayout {
  readonly type = 'masonry';
  private readonly delegate: MasonryLayoutDelegate;
  private _contentHeight = 0;
  private _positions: number[] = [];
  private _containerWidth = 0;

  constructor(delegate: MasonryLayoutDelegate) {
    this.delegate = delegate;
  }

  prepare(context: LayoutContext): void {
    const d = this.delegate;
    this._containerWidth = context.containerWidth;

    // For each section, compute masonry layout
    // Currently supports single section — multi-section masonry is a future extension
    const sec = context.sections[0];
    if (!sec || sec.itemCount === 0 || context.containerWidth <= 0) {
      this._contentHeight = 0;
      this._positions = [];
      return;
    }

    const w = context.containerWidth;
    const effectiveColumns = typeof d.columns === 'function' ? d.columns(w) : d.columns;

    // Build heights array via per-index callback
    const heights: number[] = new Array(sec.itemCount);
    for (let i = 0; i < sec.itemCount; i++) {
      heights[i] = d.heightForItem(i, 0, w);
    }

    // Build keys array
    const keys: string[] = new Array(sec.itemCount);
    for (let i = 0; i < sec.itemCount; i++) {
      keys[i] = `masonry-${i}`;
    }

    const result = nativeMod.masonryLayout.computeMasonryLayout({
      itemCount: sec.itemCount,
      columns: effectiveColumns,
      columnSpacing: d.columnSpacing ?? 8,
      rowSpacing: d.rowSpacing ?? 8,
      viewportWidth: context.containerWidth,
      sectionInsetTop: sec.insets?.top ?? 0,
      sectionInsetBottom: sec.insets?.bottom ?? 0,
      sectionInsetLeft: sec.insets?.left ?? 0,
      sectionInsetRight: sec.insets?.right ?? 0,
      itemHeights: heights,
      keys,
    });

    this._positions = result.positions;
    this._contentHeight = result.contentHeight;
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    // Scan positions array for items intersecting the rect
    const result: LayoutAttributes[] = [];
    const pos = this._positions;
    const n = pos.length / 4;

    for (let i = 0; i < n; i++) {
      const x = pos[i * 4]!;
      const y = pos[i * 4 + 1]!;
      const w = pos[i * 4 + 2]!;
      const h = pos[i * 4 + 3]!;

      // Check intersection with query rect
      if (y + h < inRect.y || y > inRect.y + inRect.height) continue;
      if (x + w < inRect.x || x > inRect.x + inRect.width) continue;

      result.push({
        key: `masonry-${i}`,
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
      key: `masonry-${index}`,
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
    // Masonry supplementary views — future extension
    return null;
  }

  contentSize(): Size {
    return { width: this._containerWidth, height: this._contentHeight };
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    // Masonry must reflow when container width changes (column widths change)
    return Math.abs(oldBounds.width - newBounds.width) > 0.5;
  }

  invalidationScope(): InvalidationScope {
    return { type: 'full' };
  }
}

/**
 * Create a masonry layout with the given delegate configuration.
 *
 * ```typescript
 * layout={masonry({
 *   columns: 3,
 *   heightForItem: (index) => imageHeights[index],
 *   columnSpacing: 8,
 *   rowSpacing: 8,
 *   stickyMode: 'push',
 * })}
 * ```
 */
export function masonry(delegate: MasonryLayoutDelegate): CollectionViewLayout {
  return new MasonryLayoutEngine(delegate);
}
