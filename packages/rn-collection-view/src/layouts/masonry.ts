/**
 * Masonry Layout — fixed-column, variable-height, shortest-column placement.
 *
 * Backed by the C++ MasonryLayout engine via JSI.
 * `columns` and `heightForItem` are mandatory.
 *
 * Multi-section support: each section gets its own header/footer/background/separators.
 * The C++ engine writes all LayoutAttributes to the shared LayoutCache.
 * All queries go through the LayoutCache so ShadowNode corrections are immediately visible.
 *
 * Standard JSI contract (mirrors GridLayout):
 *   nativeMod.masonryLayout.computeSections(sections[])       → void
 *   nativeMod.masonryLayout.invalidateSectionsFrom(n, [])     → void
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "masonry-{section}-{index}"
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
    setHorizontal(horizontal: boolean): void;
    clear(): void;
  };
  masonryLayout: {
    /** Legacy single-section method. Kept for compatibility. */
    computeMasonryLayout(params: object): { positions: number[]; contentHeight: number };
    /** Standard multi-section method — preferred. */
    computeSections(sections: object[]): void;
    /** Standard partial re-layout from fromSection onward. */
    invalidateSectionsFrom(fromSection: number, sections: object[]): void;
  };
};

class MasonryLayoutEngine implements CollectionViewLayout {
  readonly type = 'masonry';
  readonly horizontal: boolean;
  private readonly delegate: MasonryLayoutDelegate;
  private lastSectionKeys: (readonly string[])[] = [];

  constructor(delegate: MasonryLayoutDelegate) {
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

    const effectiveColumns = typeof d.columns === 'function' ? d.columns(w) : d.columns;

    const sections = context.sections.map((sec, sectionIndex) => {
      // Build per-item heights.
      // V-masonry: heights determine which lane is shortest → placement.
      // H-masonry: Yoga measures widths (primary axis); heights are uniform (cross axis).
      let itemHeights: number[] | undefined;
      if (!H) {
        itemHeights = new Array(sec.itemCount);
        for (let i = 0; i < sec.itemCount; i++) {
          const measured = context.measuredHeightForItem?.(i, sectionIndex);
          itemHeights[i] = measured ?? d.heightForItem(i, sectionIndex, w);
        }
      }

      // Keys: prefer section.itemKeys for stable identity, else fallback prefix.
      const keyPrefix = `masonry-${sectionIndex}-`;
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
        columns: effectiveColumns,
        columnSpacing: d.columnSpacing ?? 0,
        rowSpacing: d.rowSpacing ?? 0,
        viewportWidth: w,
        sectionInsetTop: sec.insets?.top ?? 0,
        sectionInsetBottom: sec.insets?.bottom ?? 0,
        sectionInsetLeft: sec.insets?.left ?? 0,
        sectionInsetRight: sec.insets?.right ?? 0,
        headerHeight: headerH,
        footerHeight: footerH,
        emitSectionBackground: d.sectionBackground ?? false,
        emitSeparators: !!d.separator,
        separatorHeight: d.separator?.height ?? 0.5,
        separatorInsetLeading: d.separator?.insetLeading ?? 0,
        separatorInsetTrailing: d.separator?.insetTrailing ?? 0,
        sectionSpacing: d.sectionSpacing ?? 0,
        // sectionBackground content insets — applied at C++ frame emission time.
        sectionBackgroundInsetTop:    d.sectionBackgroundContentInsets?.top    ?? 0,
        sectionBackgroundInsetBottom: d.sectionBackgroundContentInsets?.bottom ?? 0,
        sectionBackgroundInsetLeft:   d.sectionBackgroundContentInsets?.left   ?? 0,
        sectionBackgroundInsetRight:  d.sectionBackgroundContentInsets?.right  ?? 0,
        // Horizontal mode params
        horizontal: H,
        // H-masonry: viewportHeight passed as 0 (self-determined from content, same as H-grid).
        viewportHeight: H ? 0 : context.containerHeight,
        estimatedCrossAxisHeight: d.estimatedCrossAxisHeight ?? 200,
        keys,
        keyPrefix: '', // keys are provided explicitly above
        ...(itemHeights ? { itemHeights } : {}),
      };
    });

    this.lastSectionKeys = context.sections.map(s => s.itemKeys ?? []);
    nativeMod.masonryLayout.computeSections(sections);
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    return nativeMod.layoutCache.getAttributesInRect(inRect);
  }

  attributesForItem(index: number, section: number): LayoutAttributes | null {
    const sectionKeys = this.lastSectionKeys[section];
    const key = sectionKeys?.[index] ?? `masonry-${section}-${index}`;
    return nativeMod.layoutCache.getAttributes(key);
  }

  attributesForSupplementary(kind: string, section: number): LayoutAttributes | null {
    return nativeMod.layoutCache.getAttributes(`masonry-${section}-${kind}`);
  }

  contentSize(): Size {
    return nativeMod.layoutCache.getTotalContentSize();
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    // V-masonry: re-layout when viewport width changes (lane widths change).
    // H-masonry: cross-axis height is self-determined — never re-layout on height changes.
    // Same oscillation risk as H-grid: height update → containerH changes → shouldInvalidate
    // → prepare() resets _maxCrossAxisHeight → height changes again → loop.
    if (this.horizontal) return false;
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
 * // Vertical masonry — 2 columns, variable height
 * layout={masonry({
 *   columns: 2,
 *   heightForItem: (index, section, w) => imageHeights[index],
 *   columnSpacing: 8,
 *   rowSpacing: 8,
 *   headerHeight: 44,
 *   stickyMode: 'push',
 * })}
 *
 * // Horizontal masonry — 3 rows, variable width
 * layout={masonry({
 *   horizontal: true,
 *   columns: 3,
 *   heightForItem: (index, section, w) => 0, // unused in H-mode
 *   estimatedCrossAxisHeight: 150,
 * })}
 * ```
 */
export function masonry(delegate: MasonryLayoutDelegate): CollectionViewLayout {
  return new MasonryLayoutEngine(delegate);
}
