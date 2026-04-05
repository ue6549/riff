/**
 * Flow Layout — variable-width items, greedy bin-packing, wraps to next line.
 *
 * Backed by the C++ FlowLayout engine via JSI.
 * V-mode: items pack left-to-right, wrap when next item doesn't fit row width.
 * H-mode: items pack top-to-bottom, wrap when next item doesn't fit column height.
 * Row height (V) / column width (H) = max cross-axis size of items in that row/column.
 *
 * `sizeForItem` is mandatory — flow layout needs both width and height for bin-packing.
 *
 * Multi-section support: each section gets its own header/footer/background/separators.
 * The C++ engine writes all LayoutAttributes to the shared LayoutCache.
 * All queries go through the LayoutCache so ShadowNode corrections are immediately visible.
 *
 * Standard JSI contract (mirrors GridLayout):
 *   nativeMod.flowLayout.computeSections(sections[])       → void
 *   nativeMod.flowLayout.invalidateSectionsFrom(n, [])     → void
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "flow-{section}-{index}"
 *   2. TS attributesForItem() — reads from lastSectionKeys[section][index] (same key)
 *   3. CollectionView.tsx cacheKey — derived from layoutContext.sections[s].itemKeys[i]
 *
 * Identity keys from keyExtractor flow as:
 *   keyExtractor → layoutContext.sections[s].itemKeys → prepare() keys[] → C++ → TS read
 *
 * Violation = silent rendering failures (wrong width, lost measurements, broken sticky).
 * See docs/COLLECTIONVIEW_INTERNALS.md "RULE: Stable Key Consistency" for full details.
 * ─────────────────────────────────────────────────────────────────────────────
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
    setHorizontal(horizontal: boolean): void;
    clear(): void;
  };
  flowLayout: {
    /** Legacy single-section method. Kept for compatibility. */
    computeFlowLayout(params: object): { positions: number[]; contentHeight: number };
    /** Standard multi-section method — preferred. */
    computeSections(sections: object[]): void;
    /** Standard partial re-layout from fromSection onward. */
    invalidateSectionsFrom(fromSection: number, sections: object[]): void;
  };
};

class FlowLayoutEngine implements CollectionViewLayout {
  readonly type = 'flow';
  readonly horizontal: boolean;
  private readonly delegate: FlowLayoutDelegate;
  private lastSectionKeys: (readonly string[])[] = [];

  constructor(delegate: FlowLayoutDelegate) {
    this.delegate = delegate;
    this.horizontal = delegate.horizontal ?? false;
  }

  prepare(context: LayoutContext): void {
    const d = this.delegate;
    const H = this.horizontal;
    const w = context.containerWidth;

    if (w <= 0 || context.sections.length === 0) return;

    // Inform LayoutCache of scroll axis for MVC anchor computation.
    nativeMod.layoutCache.setHorizontal(H);

    const sections = context.sections.map((sec, sectionIndex) => {
      // Build per-item widths and heights.
      // Both dimensions are provided: W from sizeForItem (estimated), H from sizeForItem or Yoga.
      const itemWidths: number[]  = new Array(sec.itemCount);
      const itemHeights: number[] = new Array(sec.itemCount);

      for (let i = 0; i < sec.itemCount; i++) {
        const size = d.sizeForItem(i, sectionIndex, w);
        const measuredH = context.measuredHeightForItem?.(i, sectionIndex);
        itemWidths[i]  = size.width;
        itemHeights[i] = measuredH ?? size.height;
      }

      // Keys: prefer section.itemKeys for stable identity, else fallback prefix.
      const keyPrefix = `flow-${sectionIndex}-`;
      const keys: string[] = sec.itemKeys
        ? Array.from(sec.itemKeys)
        : Array.from({ length: sec.itemCount }, (_, i) => `${keyPrefix}${i}`);

      // Supplementary heights: prefer section config over delegate.
      const headerInfo = sec.supplementaryItems.find(s => s.kind === 'header');
      const footerInfo = sec.supplementaryItems.find(s => s.kind === 'footer');
      const headerH = headerInfo ? headerInfo.size.height
        : (d.heightForHeader ? d.heightForHeader(sectionIndex) : (d.headerHeight ?? 0));
      const footerH = footerInfo ? footerInfo.size.height
        : (d.heightForFooter ? d.heightForFooter(sectionIndex) : (d.footerHeight ?? 0));

      return {
        itemCount: sec.itemCount,
        itemSpacing: d.itemSpacing ?? 0,
        lineSpacing: d.lineSpacing ?? 0,
        viewportWidth: w,
        // H-flow: viewportHeight is the fixed container height (cross-axis extent).
        viewportHeight: H ? context.containerHeight : 0,
        sectionInsetTop:    sec.insets?.top    ?? 0,
        sectionInsetBottom: sec.insets?.bottom ?? 0,
        sectionInsetLeft:   sec.insets?.left   ?? 0,
        sectionInsetRight:  sec.insets?.right  ?? 0,
        headerHeight: headerH,
        footerHeight: footerH,
        emitSectionBackground: d.sectionBackground ?? false,
        emitSeparators: !!d.separator,
        separatorHeight: d.separator?.height ?? 0.5,
        separatorInsetLeading:  d.separator?.insetLeading  ?? 0,
        separatorInsetTrailing: d.separator?.insetTrailing ?? 0,
        sectionSpacing: d.sectionSpacing ?? 0,
        // sectionBackground content insets — applied at C++ frame emission time.
        sectionBackgroundInsetTop:    d.sectionBackgroundContentInsets?.top    ?? 0,
        sectionBackgroundInsetBottom: d.sectionBackgroundContentInsets?.bottom ?? 0,
        sectionBackgroundInsetLeft:   d.sectionBackgroundContentInsets?.left   ?? 0,
        sectionBackgroundInsetRight:  d.sectionBackgroundContentInsets?.right  ?? 0,
        horizontal: H,
        itemWidths,
        itemHeights,
        keys,
        keyPrefix: '', // keys are provided explicitly above
      };
    });

    this.lastSectionKeys = context.sections.map(s => s.itemKeys ?? []);
    nativeMod.flowLayout.computeSections(sections);
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    return nativeMod.layoutCache.getAttributesInRect(inRect);
  }

  attributesForItem(index: number, section: number): LayoutAttributes | null {
    const sectionKeys = this.lastSectionKeys[section];
    const key = sectionKeys?.[index] ?? `flow-${section}-${index}`;
    return nativeMod.layoutCache.getAttributes(key);
  }

  attributesForSupplementary(kind: string, section: number): LayoutAttributes | null {
    return nativeMod.layoutCache.getAttributes(`flow-${section}-${kind}`);
  }

  contentSize(): Size {
    return nativeMod.layoutCache.getTotalContentSize();
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    // Re-layout when the cross-axis (packing direction) size changes:
    //   V-flow: cross = width → invalidate on width change
    //   H-flow: cross = height → invalidate on height change
    // Unlike H-masonry, H-flow's container height is an INPUT (not content-determined),
    // so there's no oscillation risk — we DO invalidate on height change.
    if (this.horizontal) {
      return Math.abs(oldBounds.height - newBounds.height) > 0.5;
    }
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
 * // Vertical flow — tag cloud
 * layout={flow({
 *   sizeForItem: (index) => ({ width: tagWidths[index], height: 34 }),
 *   itemSpacing: 8,
 *   lineSpacing: 8,
 *   headerHeight: 44,
 *   stickyMode: 'push',
 * })}
 *
 * // Horizontal flow — items pack top→bottom into columns
 * layout={flow({
 *   horizontal: true,
 *   sizeForItem: (index) => ({ width: 80, height: tagHeights[index] }),
 *   itemSpacing: 6,
 *   lineSpacing: 12,
 * })}
 * ```
 */
export function flow(delegate: FlowLayoutDelegate): CollectionViewLayout {
  return new FlowLayoutEngine(delegate);
}
