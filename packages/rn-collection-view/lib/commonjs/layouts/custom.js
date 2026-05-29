"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.customLayout = customLayout;
/**
 * Custom Layout — full-control layout for power users.
 *
 * The consumer provides `attributesForItem` which computes layout attributes
 * for each item. Supports arbitrary positioning, transforms, opacity, z-ordering.
 *
 * Used for layouts that don't fit built-in patterns: circular, carousel, 3D, etc.
 */

class CustomLayoutEngine {
  type = 'custom';
  /** Custom layouts default to spatial query — items may not be contiguously ordered. */
  needsSpatialQuery = true;
  _attrs = [];
  _contentWidth = 0;
  _contentHeight = 0;
  constructor(delegate) {
    this.delegate = delegate;
    this.horizontal = delegate.horizontal ?? false;
  }
  prepare(context) {
    this._contentWidth = context.containerWidth;
    this._attrs = [];
    let maxY = 0;
    for (let sIdx = 0; sIdx < context.sections.length; sIdx++) {
      const sec = context.sections[sIdx];
      for (let i = 0; i < sec.itemCount; i++) {
        const attr = this.delegate.attributesForItem(i, sIdx, context);
        this._attrs.push(attr);
        const bottom = attr.frame.y + attr.frame.height;
        if (bottom > maxY) maxY = bottom;
      }
    }
    this._contentHeight = maxY;
  }
  attributesForElements(inRect) {
    const result = [];
    for (const attr of this._attrs) {
      const f = attr.frame;
      if (f.y + f.height < inRect.y || f.y > inRect.y + inRect.height) continue;
      if (f.x + f.width < inRect.x || f.x > inRect.x + inRect.width) continue;
      result.push(attr);
    }
    return result;
  }
  attributesForItem(index, section) {
    return this._attrs.find(a => a.index === index && a.section === section) ?? null;
  }
  attributesForSupplementary(_kind, _section) {
    // Custom layouts handle supplementary views via attributesForItem
    return null;
  }
  contentSize() {
    return {
      width: this._contentWidth,
      height: this._contentHeight
    };
  }
  shouldInvalidate(oldBounds, newBounds) {
    // Custom layouts should recompute on any bounds change
    return Math.abs(oldBounds.width - newBounds.width) > 0.5 || Math.abs(oldBounds.height - newBounds.height) > 0.5;
  }
  invalidationScope() {
    return {
      type: 'full'
    };
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
function customLayout(delegate) {
  return new CustomLayoutEngine(delegate);
}
//# sourceMappingURL=custom.js.map