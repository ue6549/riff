/**
 * Custom Layout — full-control layout for power users.
 *
 * The consumer provides `attributesForItem` which computes layout attributes
 * for each item. Supports arbitrary positioning, transforms, opacity, z-ordering.
 *
 * Used for layouts that don't fit built-in patterns: circular, carousel, 3D, etc.
 */

import type {
  RiffLayout,
  LayoutContext,
  RiffCustomConfig,
  RiffInvalidationScope,
} from '../types/protocol';
import type { LayoutAttributes, Rect, Size } from '../types';

class CustomLayoutEngine implements RiffLayout {
  readonly type = 'custom';
  readonly horizontal: boolean;
  /** Custom layouts default to spatial query — items may not be contiguously ordered. */
  readonly needsSpatialQuery = true;
  // Custom layouts can write arbitrary per-item visual attrs — safe default true.
  readonly writesVisualAttributes = true;
  private readonly delegate: RiffCustomConfig;
  private _attrs: LayoutAttributes[] = [];
  private _contentWidth = 0;
  private _contentHeight = 0;

  constructor(delegate: RiffCustomConfig) {
    this.delegate = delegate;
    this.horizontal = delegate.horizontal ?? false;
  }

  prepare(context: LayoutContext): void {
    this._contentWidth = context.containerWidth;
    this._attrs = [];
    let maxY = 0;

    for (let sIdx = 0; sIdx < context.sections.length; sIdx++) {
      const sec = context.sections[sIdx]!;
      for (let i = 0; i < sec.itemCount; i++) {
        const attr = this.delegate.attributesForItem(i, sIdx, context);
        this._attrs.push(attr);
        const bottom = attr.frame.y + attr.frame.height;
        if (bottom > maxY) maxY = bottom;
      }
    }

    this._contentHeight = maxY;
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    const result: LayoutAttributes[] = [];

    for (const attr of this._attrs) {
      const f = attr.frame;
      if (f.y + f.height < inRect.y || f.y > inRect.y + inRect.height) continue;
      if (f.x + f.width < inRect.x || f.x > inRect.x + inRect.width) continue;
      result.push(attr);
    }

    return result;
  }

  attributesForItem(index: number, section: number): LayoutAttributes | null {
    return this._attrs.find(a => a.index === index && a.section === section) ?? null;
  }

  attributesForSupplementary(_kind: string, _section: number): LayoutAttributes | null {
    // Custom layouts handle supplementary views via attributesForItem
    return null;
  }

  contentSize(): Size {
    return { width: this._contentWidth, height: this._contentHeight };
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    // Custom layouts should recompute on any bounds change
    return (
      Math.abs(oldBounds.width - newBounds.width) > 0.5 ||
      Math.abs(oldBounds.height - newBounds.height) > 0.5
    );
  }

  invalidationScope(): RiffInvalidationScope {
    return { type: 'full' };
  }
}

/**
 * Create a custom layout with the given delegate configuration.
 *
 * ```typescript
 * layout={customLayout({
 *   attributesForItem: (index, section, context) => ({
 *     key: `item-${index}`,
 *     section,
 *     index,
 *     frame: { x: ..., y: ..., width: ..., height: ... },
 *     zIndex: computeDepth(index, context),
 *   }),
 * })}
 * ```
 */
export function customLayout(delegate: RiffCustomConfig): RiffLayout {
  return new CustomLayoutEngine(delegate);
}
