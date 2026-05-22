/**
 * Grid Layout — fixed columns, row-aligned heights.
 *
 * Backed by the C++ GridLayout engine via JSI.
 * Items placed left-to-right in rows. Each row's height = tallest item in that row
 * (or fixed `rowHeight` if provided — actual height determined by Yoga for dynamic rows).
 *
 * Multi-section support: each section gets its own header/footer/background/separators.
 * The C++ engine writes all LayoutAttributes to the shared LayoutCache.
 * All queries go through the LayoutCache so ShadowNode corrections are immediately visible.
 *
 * Standard JSI contract (mirrors ListLayout):
 *   this._gridEngine.computeSections(sections[])       → void
 *   this._gridEngine.invalidateSectionsFrom(n, [])     → void
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "grid-{section}-{index}"
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
    setHorizontal(horizontal: boolean): void;
    stashMeasuredSizes(): void;
    clearStash(): void;
    clear(): void;
  };
  layoutCacheById(id: number): {
    getAttributesInRect(rect: { x: number; y: number; width: number; height: number }): LayoutAttributes[];
    getAttributes(key: string): LayoutAttributes | null;
    getTotalContentSize(): Size;
    setHorizontal(horizontal: boolean): void;
    stashMeasuredSizes(): void;
    clearStash(): void;
    clear(): void;
  };
  gridLayout: {
    computeSections(sections: object[]): void;
    invalidateSectionsFrom(fromSection: number, sections: object[]): void;
  };
  getGridLayoutById(id: number): {
    computeSections(sections: object[]): void;
    invalidateSectionsFrom(fromSection: number, sections: object[]): void;
  };
};

class GridLayoutEngine implements CollectionViewLayout {
  readonly type = 'grid';
  readonly horizontal: boolean;
  readonly delegate: GridLayoutDelegate;
  private lastSectionKeys: (readonly string[])[] = [];
  private _cache = nativeMod.layoutCache;
  private _gridEngine = nativeMod.gridLayout;

  constructor(delegate: GridLayoutDelegate) {
    this.delegate = delegate;
    this.horizontal = delegate.horizontal ?? false;
  }

  prepare(context: LayoutContext): void {
    this._cache      = nativeMod.layoutCacheById(context.cacheId);
    this._gridEngine = nativeMod.getGridLayoutById(context.cacheId);
    const d = this.delegate;
    const H = this.horizontal;
    const w = context.containerWidth;

    if (w <= 0 || context.sections.length === 0) return;

    // Inform LayoutCache of scroll axis for MVC anchor computation.
    this._cache.setHorizontal(H);

    const effectiveColumns = typeof d.columns === 'function' ? d.columns(w) : d.columns;
    const effectiveRowHeight = typeof d.rowHeight === 'function' ? d.rowHeight(w) : (d.rowHeight ?? 0);

    let runningFlatBase = 0;
    const sections = context.sections.map((sec, sectionIndex) => {
      const hasHeader = sec.supplementaryItems.some(s => s.kind === 'header');
      const hasFooter = sec.supplementaryItems.some(s => s.kind === 'footer');
      const sectionFlatBase = runningFlatBase;
      runningFlatBase += (hasHeader ? 1 : 0) + sec.itemCount + (hasFooter ? 1 : 0);
      // Build per-item heights when rows are dynamic (no fixed rowHeight).
      // For horizontal mode: heights are cross-axis sizes derived from column count —
      // no per-item measurement needed here; Yoga measures primary-axis widths.
      let itemHeights: number[] | undefined;
      if (!H && !effectiveRowHeight && (d.heightForItem || context.measuredHeightForItem)) {
        itemHeights = new Array(sec.itemCount);
        for (let i = 0; i < sec.itemCount; i++) {
          const measured = context.measuredHeightForItem?.(i, sectionIndex);
          itemHeights[i] = measured ?? (d.heightForItem ? d.heightForItem(i, sectionIndex, w) : 44);
        }
      }

      // Keys: prefer section.itemKeys for stable identity, else fallback prefix
      const keyPrefix = `grid-${sectionIndex}-`;
      const keys: string[] = sec.itemKeys
        ? Array.from(sec.itemKeys)
        : Array.from({ length: sec.itemCount }, (_, i) => `${keyPrefix}${i}`);

      // Use section config heights (ground truth from supplementaryItems) when available;
      // fall back to delegate if section has no header/footer configured.
      const headerInfo = sec.supplementaryItems.find(s => s.kind === 'header');
      const footerInfo = sec.supplementaryItems.find(s => s.kind === 'footer');
      const headerH = headerInfo ? headerInfo.size.height
        : (d.heightForHeader ? d.heightForHeader(sectionIndex) : (d.headerHeight ?? 0));
      const footerH = footerInfo ? footerInfo.size.height
        : (d.heightForFooter ? d.heightForFooter(sectionIndex) : (d.footerHeight ?? 0));

      return {
        flatIndexBase: sectionFlatBase + (hasHeader ? 1 : 0),
        headerFlatIndex: hasHeader ? sectionFlatBase : -1,
        footerFlatIndex: hasFooter ? sectionFlatBase + (hasHeader ? 1 : 0) + sec.itemCount : -1,
        itemCount: sec.itemCount,
        columns: effectiveColumns,
        columnSpacing: d.columnSpacing ?? 0,
        rowSpacing: d.rowSpacing ?? 0,
        viewportWidth: w,
        rowHeight: effectiveRowHeight,
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
        // H-grid: viewportHeight is not used for cross-axis sizing (always adaptive).
        // Passed as 0 so C++ knows container height is not pre-specified.
        viewportHeight: H ? 0 : context.containerHeight,
        estimatedCrossAxisHeight: d.estimatedCrossAxisHeight ?? 200,
        keys,
        keyPrefix: '', // keys are provided explicitly above
        ...(itemHeights ? { itemHeights } : {}),
      };
    });

    this.lastSectionKeys = context.sections.map(s => s.itemKeys ?? []);
    if (H) this._cache.stashMeasuredSizes();
    this._gridEngine.computeSections(sections);
    if (H) this._cache.clearStash();
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    return this._cache.getAttributesInRect(inRect);
  }

  cacheKeyForItem(index: number, section: number): string {
    return this.lastSectionKeys[section]?.[index] ?? `grid-${section}-${index}`;
  }

  cacheKeyForSupplementary(kind: string, section: number): string {
    return `grid-${section}-${kind}`;
  }

  attributesForItem(index: number, section: number): LayoutAttributes | null {
    return this._cache.getAttributes(this.cacheKeyForItem(index, section));
  }

  attributesForSupplementary(kind: string, section: number): LayoutAttributes | null {
    return this._cache.getAttributes(this.cacheKeyForSupplementary(kind, section));
  }

  contentSize(): Size {
    return this._cache.getTotalContentSize();
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    // V-grid: re-layout when viewport width changes (column widths change).
    // H-grid: cross-axis height is self-determined from item content — never re-layout
    // based on viewport height changes. Doing so causes oscillation: height update →
    // containerH changes → scrollView height changes → shouldInvalidate → prepare() resets
    // _maxCrossAxisHeight → height changes again → loop.
    if (this.horizontal) return false;
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
 * // Uniform row height (fast path — no measurement per row)
 * layout={grid({ columns: 3, rowHeight: 100, columnSpacing: 8, rowSpacing: 8 })}
 *
 * // Dynamic row height (row height = tallest item in each row)
 * layout={grid({ columns: 3, heightForItem: (i) => heights[i], columnSpacing: 8 })}
 *
 * // Multi-section with sticky headers and section backgrounds
 * layout={grid({
 *   columns: 2,
 *   rowHeight: 120,
 *   headerHeight: 44,
 *   footerHeight: 24,
 *   sectionBackground: true,
 *   stickyMode: 'push',
 * })}
 * ```
 */
export function grid(delegate: GridLayoutDelegate): CollectionViewLayout {
  return new GridLayoutEngine(delegate);
}
