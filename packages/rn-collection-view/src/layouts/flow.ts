/**
 * Flow Layout — dynamic columns based on item dimensions, wraps to next line.
 *
 * Backed by the C++ FlowLayout engine via JSI.
 * Items pack left-to-right. When the next item doesn't fit in the remaining
 * row width, it wraps to a new line. Row height = tallest item in that row.
 *
 * `sizeForItem` is mandatory — flow layout needs both width and height.
 */

import type {
  CollectionViewLayout,
  LayoutContext,
  FlowLayoutDelegate,
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
  flowLayout: {
    computeFlowLayout(params: {
      itemCount: number;
      itemSpacing: number;
      lineSpacing: number;
      viewportWidth: number;
      sectionInsetTop?: number;
      sectionInsetBottom?: number;
      sectionInsetLeft?: number;
      sectionInsetRight?: number;
      itemWidths: number[];
      itemHeights: number[];
      keys: string[];
    }): { positions: number[]; contentHeight: number };
  };
};

class FlowLayoutEngine implements CollectionViewLayout {
  readonly type = 'flow';
  private readonly delegate: FlowLayoutDelegate;
  private _contentHeight = 0;
  private _positions: number[] = [];
  private _containerWidth = 0;

  constructor(delegate: FlowLayoutDelegate) {
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

    // Build widths and heights arrays via per-index callback
    const widths: number[] = new Array(sec.itemCount);
    const heights: number[] = new Array(sec.itemCount);
    const w = context.containerWidth;
    for (let i = 0; i < sec.itemCount; i++) {
      const size = d.sizeForItem(i, 0, w);
      widths[i] = size.width;
      heights[i] = size.height;
    }

    // Build keys array
    const keys: string[] = new Array(sec.itemCount);
    for (let i = 0; i < sec.itemCount; i++) {
      keys[i] = `flow-${i}`;
    }

    const result = nativeMod.flowLayout.computeFlowLayout({
      itemCount: sec.itemCount,
      itemSpacing: d.itemSpacing ?? 0,
      lineSpacing: d.lineSpacing ?? 0,
      viewportWidth: context.containerWidth,
      sectionInsetTop: sec.insets?.top ?? 0,
      sectionInsetBottom: sec.insets?.bottom ?? 0,
      sectionInsetLeft: sec.insets?.left ?? 0,
      sectionInsetRight: sec.insets?.right ?? 0,
      itemWidths: widths,
      itemHeights: heights,
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
        key: `flow-${i}`,
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
      key: `flow-${index}`,
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
    // Flow layout MUST reflow when width changes — items per row changes
    return Math.abs(oldBounds.width - newBounds.width) > 0.5;
  }

  invalidationScope(): InvalidationScope {
    return { type: 'full' };
  }
}

/**
 * Create a flow layout with the given delegate configuration.
 *
 * ```typescript
 * layout={flow({
 *   sizeForItem: (index) => ({ width: tagWidths[index], height: 32 }),
 *   itemSpacing: 6,
 *   lineSpacing: 8,
 * })}
 * ```
 */
export function flow(delegate: FlowLayoutDelegate): CollectionViewLayout {
  return new FlowLayoutEngine(delegate);
}
