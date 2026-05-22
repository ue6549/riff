/**
 * Compositional Layout — per-section layout types within a single CollectionView.
 *
 * Each section can independently use list, grid, flow, or masonry layout.
 * All sections share one scroll context, one LayoutCache, and one processScroll call —
 * no nested scroll views, no competing gesture recognizers, one recycling pool.
 *
 * Phase 1: Vertical scroll only. Phase 2 (follow-up): native orthogonal sections.
 *
 * API:
 *   layout={compositional([
 *     { range: [0, 0], layout: list({ estimatedItemHeight: 200 }) },
 *     { range: [1, 1], layout: grid({ columns: 4, rowHeight: 80 }) },
 *     { range: [2, 2], layout: flow({ sizeForItem: tagSize }) },
 *     { range: [3, 3], layout: masonry({ columns: 2, heightForItem: h }) },
 *   ])}
 *
 * Range shorthand: `{ range: 3 }` = `{ range: [3, 3] }` (single section).
 * Last entry's layout repeats for sections beyond those explicitly listed.
 *
 * ─── STABLE KEY RULE ─────────────────────────────────────────────────────────
 * Each sub-layout type uses its own LayoutCache prefix:
 *   list    → "item-{section}-{index}"
 *   grid    → "grid-{section}-{index}"
 *   flow    → "flow-{section}-{index}"
 *   masonry → "masonry-{section}-{index}"
 * Sections from different layout types naturally have non-colliding keys.
 * CollectionView.tsx uses keyPrefixForSection() to derive the right prefix.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  CollectionViewLayout,
  LayoutContext,
  SectionInfo,
  InvalidationScope,
  ListLayoutDelegate,
  GridLayoutDelegate,
  FlowLayoutDelegate,
  MasonryLayoutDelegate,
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
    stashHeights(): void;
    clearStash(): void;
  };
  layoutCacheById(id: number): {
    getAttributesInRect(rect: { x: number; y: number; width: number; height: number }): LayoutAttributes[];
    getAttributes(key: string): LayoutAttributes | null;
    getTotalContentSize(): Size;
    setHorizontal(horizontal: boolean): void;
    clear(): void;
    stashHeights(): void;
    clearStash(): void;
  };
  compositionalLayout: {
    computeSections(sections: object[]): void;
    invalidateSectionsFrom(fromSection: number, sections: object[]): void;
  };
  getCompositionalLayoutById(id: number): {
    computeSections(sections: object[]): void;
    invalidateSectionsFrom(fromSection: number, sections: object[]): void;
  };
};

// ── Public API types ──────────────────────────────────────────────────────────

/** Single section index or an inclusive [from, to] range. */
export type SectionRange = number | [number, number];

/** Maps a section range to a layout engine. */
export interface CompositionalEntry {
  range: SectionRange;
  layout: CollectionViewLayout;
  /**
   * Phase 2: set `horizontal: true` to make this section scroll horizontally.
   * The section is rendered inside `RNOrthogonalSectionView` (a UIScrollView)
   * with native momentum, directional lock, and H-axis item clipping.
   * Default: false (vertical, same as all Phase 1 sections).
   */
  horizontal?: boolean;
  /**
   * For H-sections only: the height this section occupies in the outer vertical scroll.
   * - Flow H: required (or estimated from first item height). Controls how many rows of items fit.
   * - Grid / List / Masonry H: optional override; defaults to estimatedCrossAxisHeight from delegate.
   */
  estimatedSectionHeight?: number;
}

/** Post-prepare metadata for an H-section (horizontal=true entry). */
export interface HSectionMeta {
  sectionY: number;
  sectionHeight: number;
  flatBase: number;
  itemCount: number;
  contentWidth: number;
}

// ── Param-building helpers ────────────────────────────────────────────────────
// These mirror the prepare() logic in each individual layout engine, but as pure
// functions that build one section's params without calling computeSections().
// CompositionalLayout accumulates all sections then sends them in one JSI call.

type MeasuredHeightFn = ((index: number, section: number) => number | undefined) | undefined;

/**
 * Extract header/footer heights from any delegate type.
 * Used by the compositional engine to compute Level 1 (parent) supplementary heights.
 */
function extractSupplementaryHeights(
  d: { heightForHeader?: (s: number) => number; headerHeight?: number; estimatedHeaderHeight?: number;
       heightForFooter?: (s: number) => number; footerHeight?: number; estimatedFooterHeight?: number;
       sectionBackground?: boolean; sectionSpacing?: number },
  sec: SectionInfo,
  sectionIndex: number,
): { headerHeight: number; footerHeight: number; emitSectionBackground: boolean; sectionSpacing: number } {
  let headerHeight = 0;
  if (d.heightForHeader) {
    headerHeight = d.heightForHeader(sectionIndex);
  } else if (d.headerHeight != null) {
    headerHeight = d.headerHeight;
  } else if (d.estimatedHeaderHeight != null) {
    headerHeight = d.estimatedHeaderHeight;
  } else {
    const headerSup = sec.supplementaryItems.find(s => s.kind === 'header');
    if (headerSup) headerHeight = headerSup.size.height;
  }

  let footerHeight = 0;
  if (d.heightForFooter) {
    footerHeight = d.heightForFooter(sectionIndex);
  } else if (d.footerHeight != null) {
    footerHeight = d.footerHeight;
  } else if (d.estimatedFooterHeight != null) {
    footerHeight = d.estimatedFooterHeight;
  } else {
    const footerSup = sec.supplementaryItems.find(s => s.kind === 'footer');
    if (footerSup) footerHeight = footerSup.size.height;
  }

  return {
    headerHeight,
    footerHeight,
    emitSectionBackground: d.sectionBackground === true,
    sectionSpacing: d.sectionSpacing ?? 0,
  };
}

function buildListSectionParams(
  d: ListLayoutDelegate,
  sec: SectionInfo,
  sectionIndex: number,
  sectionFlatBase: number,
  w: number,
  h: number,
  hasHeader: boolean,
  hasFooter: boolean,
  measuredHeightForItem: MeasuredHeightFn,
): Record<string, unknown> {
  const itemHeightVal =
    (typeof d.itemHeight === 'function' ? d.itemHeight(w) : d.itemHeight) ??
    d.estimatedItemHeight ?? 44;

  let itemHeights: number[] | undefined;
  if (d.heightForItem || measuredHeightForItem) {
    itemHeights = [];
    for (let i = 0; i < sec.itemCount; i++) {
      const measured = measuredHeightForItem?.(i, sectionIndex);
      if (measured !== undefined) {
        itemHeights.push(measured);
      } else if (d.heightForItem) {
        itemHeights.push(d.heightForItem(i, sectionIndex, w));
      } else {
        itemHeights.push(itemHeightVal);
      }
    }
  }

  let headerHeight = 0;
  if (d.heightForHeader) {
    headerHeight = d.heightForHeader(sectionIndex);
  } else if (d.headerHeight != null) {
    headerHeight = d.headerHeight;
  } else if (d.estimatedHeaderHeight != null) {
    headerHeight = d.estimatedHeaderHeight;
  } else {
    const headerSup = sec.supplementaryItems.find(s => s.kind === 'header');
    if (headerSup) headerHeight = headerSup.size.height;
  }

  let footerHeight = 0;
  if (d.heightForFooter) {
    footerHeight = d.heightForFooter(sectionIndex);
  } else if (d.footerHeight != null) {
    footerHeight = d.footerHeight;
  } else if (d.estimatedFooterHeight != null) {
    footerHeight = d.estimatedFooterHeight;
  } else {
    const footerSup = sec.supplementaryItems.find(s => s.kind === 'footer');
    if (footerSup) footerHeight = footerSup.size.height;
  }

  const params: Record<string, unknown> = {
    flatIndexBase: sectionFlatBase + (hasHeader ? 1 : 0),
    headerFlatIndex: hasHeader ? sectionFlatBase : -1,
    footerFlatIndex: hasFooter ? sectionFlatBase + (hasHeader ? 1 : 0) + sec.itemCount : -1,
    itemCount: sec.itemCount,
    itemHeight: itemHeightVal,
    viewportWidth: w,
    viewportHeight: h,
    horizontal: false,
    sectionInsetTop: sec.insets?.top ?? 0,
    sectionInsetBottom: sec.insets?.bottom ?? 0,
    sectionInsetLeft: sec.insets?.left ?? 0,
    sectionInsetRight: sec.insets?.right ?? 0,
    itemSpacing: d.itemSpacing ?? 0,
    section: sectionIndex,
    headerHeight,
    footerHeight,
    emitSectionBackground: d.sectionBackground === true,
    emitSeparators: d.separator != null,
    separatorHeight: d.separator?.height ?? 0.5,
    separatorInsetLeading: d.separator?.insetLeading ?? 0,
    separatorInsetTrailing: d.separator?.insetTrailing ?? 0,
    sectionSpacing: d.sectionSpacing ?? 0,
    sectionBackgroundInsetTop: d.sectionBackgroundContentInsets?.top ?? 0,
    sectionBackgroundInsetBottom: d.sectionBackgroundContentInsets?.bottom ?? 0,
    sectionBackgroundInsetLeft: d.sectionBackgroundContentInsets?.left ?? 0,
    sectionBackgroundInsetRight: d.sectionBackgroundContentInsets?.right ?? 0,
    estimatedCrossAxisHeight: d.estimatedCrossAxisHeight ?? 200,
  };

  if (itemHeights) params.itemHeights = itemHeights;
  if (sec.itemKeys) params.keys = sec.itemKeys;

  return params;
}

function buildGridSectionParams(
  d: GridLayoutDelegate,
  sec: SectionInfo,
  sectionIndex: number,
  sectionFlatBase: number,
  w: number,
  hasHeader: boolean,
  hasFooter: boolean,
  measuredHeightForItem: MeasuredHeightFn,
): Record<string, unknown> {
  const effectiveColumns = typeof d.columns === 'function' ? d.columns(w) : d.columns;
  const effectiveRowHeight =
    typeof d.rowHeight === 'function' ? d.rowHeight(w) : (d.rowHeight ?? 0);

  let itemHeights: number[] | undefined;
  if (!effectiveRowHeight && (d.heightForItem || measuredHeightForItem)) {
    itemHeights = new Array(sec.itemCount);
    for (let i = 0; i < sec.itemCount; i++) {
      const measured = measuredHeightForItem?.(i, sectionIndex);
      itemHeights[i] = measured ?? (d.heightForItem ? d.heightForItem(i, sectionIndex, w) : 44);
    }
  }

  const keyPrefix = `grid-${sectionIndex}-`;
  const keys: string[] = sec.itemKeys
    ? Array.from(sec.itemKeys)
    : Array.from({ length: sec.itemCount }, (_, i) => `${keyPrefix}${i}`);

  const headerInfo = sec.supplementaryItems.find(s => s.kind === 'header');
  const footerInfo = sec.supplementaryItems.find(s => s.kind === 'footer');
  const headerH = headerInfo
    ? headerInfo.size.height
    : (d.heightForHeader ? d.heightForHeader(sectionIndex) : (d.headerHeight ?? 0));
  const footerH = footerInfo
    ? footerInfo.size.height
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
    sectionBackgroundInsetTop: d.sectionBackgroundContentInsets?.top ?? 0,
    sectionBackgroundInsetBottom: d.sectionBackgroundContentInsets?.bottom ?? 0,
    sectionBackgroundInsetLeft: d.sectionBackgroundContentInsets?.left ?? 0,
    sectionBackgroundInsetRight: d.sectionBackgroundContentInsets?.right ?? 0,
    horizontal: false,
    viewportHeight: 0,
    estimatedCrossAxisHeight: d.estimatedCrossAxisHeight ?? 200,
    keys,
    keyPrefix: '',
    ...(itemHeights ? { itemHeights } : {}),
  };
}

function buildFlowSectionParams(
  d: FlowLayoutDelegate,
  sec: SectionInfo,
  sectionIndex: number,
  sectionFlatBase: number,
  w: number,
  hasHeader: boolean,
  hasFooter: boolean,
  measuredHeightForItem: MeasuredHeightFn,
): Record<string, unknown> {
  const itemWidths: number[] = new Array(sec.itemCount);
  const itemHeights: number[] = new Array(sec.itemCount);

  for (let i = 0; i < sec.itemCount; i++) {
    const size = d.sizeForItem(i, sectionIndex, w);
    const measuredH = measuredHeightForItem?.(i, sectionIndex);
    itemWidths[i] = size.width;
    itemHeights[i] = measuredH ?? size.height;
  }

  const keyPrefix = `flow-${sectionIndex}-`;
  const keys: string[] = sec.itemKeys
    ? Array.from(sec.itemKeys)
    : Array.from({ length: sec.itemCount }, (_, i) => `${keyPrefix}${i}`);

  const headerInfo = sec.supplementaryItems.find(s => s.kind === 'header');
  const footerInfo = sec.supplementaryItems.find(s => s.kind === 'footer');
  const headerH = headerInfo
    ? headerInfo.size.height
    : (d.heightForHeader ? d.heightForHeader(sectionIndex) : (d.headerHeight ?? 0));
  const footerH = footerInfo
    ? footerInfo.size.height
    : (d.heightForFooter ? d.heightForFooter(sectionIndex) : (d.footerHeight ?? 0));

  return {
    flatIndexBase: sectionFlatBase + (hasHeader ? 1 : 0),
    headerFlatIndex: hasHeader ? sectionFlatBase : -1,
    footerFlatIndex: hasFooter ? sectionFlatBase + (hasHeader ? 1 : 0) + sec.itemCount : -1,
    itemCount: sec.itemCount,
    itemSpacing: d.itemSpacing ?? 0,
    lineSpacing: d.lineSpacing ?? 0,
    viewportWidth: w,
    viewportHeight: 0,
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
    sectionBackgroundInsetTop: d.sectionBackgroundContentInsets?.top ?? 0,
    sectionBackgroundInsetBottom: d.sectionBackgroundContentInsets?.bottom ?? 0,
    sectionBackgroundInsetLeft: d.sectionBackgroundContentInsets?.left ?? 0,
    sectionBackgroundInsetRight: d.sectionBackgroundContentInsets?.right ?? 0,
    horizontal: false,
    itemWidths,
    itemHeights,
    keys,
    keyPrefix: '',
  };
}

function buildMasonrySectionParams(
  d: MasonryLayoutDelegate,
  sec: SectionInfo,
  sectionIndex: number,
  sectionFlatBase: number,
  w: number,
  hasHeader: boolean,
  hasFooter: boolean,
  measuredHeightForItem: MeasuredHeightFn,
): Record<string, unknown> {
  const effectiveColumns = typeof d.columns === 'function' ? d.columns(w) : d.columns;

  const itemHeights: number[] = new Array(sec.itemCount);
  for (let i = 0; i < sec.itemCount; i++) {
    const measured = measuredHeightForItem?.(i, sectionIndex);
    itemHeights[i] = measured ?? (d.heightForItem ? d.heightForItem(i, sectionIndex, w) : (d.estimatedItemHeight ?? 44));
  }

  const keyPrefix = `masonry-${sectionIndex}-`;
  const keys: string[] = sec.itemKeys
    ? Array.from(sec.itemKeys)
    : Array.from({ length: sec.itemCount }, (_, i) => `${keyPrefix}${i}`);

  const headerInfo = sec.supplementaryItems.find(s => s.kind === 'header');
  const footerInfo = sec.supplementaryItems.find(s => s.kind === 'footer');
  const headerH = headerInfo
    ? headerInfo.size.height
    : (d.heightForHeader ? d.heightForHeader(sectionIndex) : (d.headerHeight ?? 0));
  const footerH = footerInfo
    ? footerInfo.size.height
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
    sectionBackgroundInsetTop: d.sectionBackgroundContentInsets?.top ?? 0,
    sectionBackgroundInsetBottom: d.sectionBackgroundContentInsets?.bottom ?? 0,
    sectionBackgroundInsetLeft: d.sectionBackgroundContentInsets?.left ?? 0,
    sectionBackgroundInsetRight: d.sectionBackgroundContentInsets?.right ?? 0,
    horizontal: false,
    viewportHeight: 0,
    estimatedCrossAxisHeight: d.estimatedCrossAxisHeight ?? 200,
    itemHeights,
    keys,
    keyPrefix: '',
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

class CompositionalLayoutEngine implements CollectionViewLayout {
  readonly type = 'compositional';
  readonly horizontal = false;
  readonly needsSpatialQuery = false;

  private readonly entries: CompositionalEntry[];
  private lastSectionKeys: (readonly string[])[] = [];
  private sectionTypes: string[] = [];
  /** Post-prepare metadata for H-sections (populated after each prepare()). */
  private hSectionMetaArr: (HSectionMeta | null)[] = [];
  /** Fingerprint of the last prepare() call — skip redundant computeSections. */
  private _lastFingerprint = '';
  // B4.9: Per-instance cache + engine (set in prepare() via context.cacheId).
  private _cache = nativeMod.layoutCache;
  private _compEngine = nativeMod.compositionalLayout;

  constructor(entries: CompositionalEntry[]) {
    this.entries = entries;
  }

  /** Find which entry applies for a given section index. */
  private resolveEntry(sectionIndex: number): CompositionalEntry {
    for (const entry of this.entries) {
      const r = entry.range;
      if (typeof r === 'number') {
        if (r === sectionIndex) return entry;
      } else {
        if (sectionIndex >= r[0] && sectionIndex <= r[1]) return entry;
      }
    }
    // Last entry repeats for sections beyond those explicitly listed.
    return this.entries[this.entries.length - 1]!;
  }

  /** Returns true if this section was marked `horizontal: true` in the entries. */
  isHSection(sectionIndex: number): boolean {
    return this.resolveEntry(sectionIndex).horizontal === true;
  }

  /** Returns H-section metadata. Reads Y/height from cache wrapper entry (always fresh). */
  hSectionInfo(sectionIndex: number): HSectionMeta | null {
    const cached = this.hSectionMetaArr[sectionIndex];
    if (!cached) return null;
    // Read wrapper Y and height from LayoutCache — always reflects latest
    // applyMeasurements / invalidateSectionsFrom reflows (avoids stale sectionY).
    const wrapperAttrs = this._cache.getAttributes(`h-section-wrapper-${sectionIndex}`);
    if (wrapperAttrs) {
      return {
        ...cached,
        sectionY: wrapperAttrs.frame.y,
        sectionHeight: wrapperAttrs.frame.height,
      };
    }
    return cached;
  }

  keyPrefixForSection(section: number): string {
    const type = this.sectionTypes[section] ?? 'list';
    return type === 'list' ? 'item' : type;
  }

  budgetColumns(viewportWidth: number): number {
    let maxCols = 1;
    for (const entry of this.entries) {
      const { type } = entry.layout;
      if (type === 'grid' || type === 'masonry') {
        const d = (entry.layout as unknown as { delegate: GridLayoutDelegate | MasonryLayoutDelegate }).delegate;
        const cols = typeof d.columns === 'function' ? d.columns(viewportWidth) : (d.columns ?? 1);
        if (cols > maxCols) maxCols = cols;
      }
    }
    return maxCols;
  }

  prepare(context: LayoutContext): void {
    this._cache      = nativeMod.layoutCacheById(context.cacheId);
    this._compEngine = nativeMod.getCompositionalLayoutById(context.cacheId);
    const w = context.containerWidth;
    const h = context.containerHeight;
    if (w <= 0 || context.sections.length === 0) return;

    // Build fingerprint: width + per-section (type, itemCount, horizontal).
    // If unchanged, skip the expensive computeSections JSI call.
    const fpParts: string[] = [String(w)];
    for (let s = 0; s < context.sections.length; s++) {
      const entry = this.resolveEntry(s);
      const sec = context.sections[s]!;
      fpParts.push(`${entry.layout.type}:${sec.itemCount}:${entry.horizontal ? 'H' : 'V'}`);
    }
    const fingerprint = fpParts.join('|');
    if (fingerprint === this._lastFingerprint) {
      // Data shape unchanged — skip full recompute. hSectionInfo reads from cache (always fresh).
      return;
    }
    this._lastFingerprint = fingerprint;

    this._cache.setHorizontal(false);

    // Stash Yoga-measured sizes before cache clear (computeSections clears).
    this._cache.stashHeights();

    this.sectionTypes = [];
    let runningFlatBase = 0;
    const sectionFlatBases: number[] = [];

    const sections = context.sections.map((sec, sectionIndex) => {
      const entry = this.resolveEntry(sectionIndex);
      const layout = entry.layout;
      const layoutType = layout.type;
      const isH = entry.horizontal === true;
      this.sectionTypes[sectionIndex] = layoutType;

      const hasHeader = sec.supplementaryItems.some(s => s.kind === 'header');
      const hasFooter = sec.supplementaryItems.some(s => s.kind === 'footer');
      const sectionFlatBase = runningFlatBase;
      sectionFlatBases[sectionIndex] = sectionFlatBase;
      runningFlatBase += (hasHeader ? 1 : 0) + sec.itemCount + (hasFooter ? 1 : 0);

      // ── Level 1: extract compositional-owned supplementary heights ──
      const d = (layout as unknown as { delegate: unknown }).delegate;
      const compSupp = extractSupplementaryHeights(
        d as any, sec, sectionIndex,
      );
      const compHeaderFlatIndex = hasHeader ? sectionFlatBase : -1;
      const compFooterFlatIndex = hasFooter
        ? sectionFlatBase + (hasHeader ? 1 : 0) + sec.itemCount
        : -1;

      // ── Level 2: build leaf params, then suppress header/footer emission ──
      // Builders use hasHeader/hasFooter for correct flatIndexBase offsets.
      // We then override header/footer heights and flat indices so the leaf
      // sub-engine only computes items — compositional owns supplementaries.
      let params: Record<string, unknown>;

      if (layoutType === 'grid') {
        params = buildGridSectionParams(
          d as GridLayoutDelegate, sec, sectionIndex, sectionFlatBase, w,
          hasHeader, hasFooter, context.measuredHeightForItem,
        );
      } else if (layoutType === 'flow') {
        params = buildFlowSectionParams(
          d as FlowLayoutDelegate, sec, sectionIndex, sectionFlatBase, w,
          hasHeader, hasFooter, context.measuredHeightForItem,
        );
      } else if (layoutType === 'masonry') {
        params = buildMasonrySectionParams(
          d as MasonryLayoutDelegate, sec, sectionIndex, sectionFlatBase, w,
          hasHeader, hasFooter, context.measuredHeightForItem,
        );
      } else {
        params = buildListSectionParams(
          d as ListLayoutDelegate, sec, sectionIndex, sectionFlatBase, w, h,
          hasHeader, hasFooter, context.measuredHeightForItem,
        );
      }

      // Ensure leaf params don't emit supplementaries (belt + suspenders).
      params.headerHeight = 0;
      params.footerHeight = 0;
      params.headerFlatIndex = -1;
      params.footerFlatIndex = -1;
      // Leaf sectionBackground is suppressed — compositional owns it at Level 1.
      params.emitSectionBackground = false;
      // Leaf sectionSpacing is suppressed — compositional owns it at Level 1.
      params.sectionSpacing = 0;

      // For H-sections, override horizontal flag and (for flow H) viewportHeight.
      if (isH) {
        const hOverrides: Record<string, unknown> = { horizontal: true };
        if (layoutType === 'flow') {
          let vh = entry.estimatedSectionHeight;
          if (!vh) {
            const fd = (layout as unknown as { delegate: FlowLayoutDelegate }).delegate;
            const itemH = sec.itemCount > 0 ? fd.sizeForItem(0, sectionIndex, w).height : 44;
            const topInset  = (params as any).sectionInsetTop    ?? 0;
            const botInset  = (params as any).sectionInsetBottom ?? 0;
            vh = itemH + topInset + botInset;
          }
          hOverrides.viewportHeight = vh;
        } else if (layoutType === 'grid' || layoutType === 'masonry' || layoutType === 'list') {
          if (entry.estimatedSectionHeight) {
            hOverrides.viewportHeight = entry.estimatedSectionHeight;
            hOverrides.estimatedCrossAxisHeight = entry.estimatedSectionHeight;
          }
        }
        params = { ...params, ...hOverrides };
      }

      // ── Attach Level 1 compositional fields (read by C++ sectionInfoFromJSI) ──
      return {
        ...params,
        layoutType,
        compHeaderHeight: compSupp.headerHeight,
        compFooterHeight: compSupp.footerHeight,
        compHeaderFlatIndex: compHeaderFlatIndex,
        compFooterFlatIndex: compFooterFlatIndex,
        compEmitSectionBackground: compSupp.emitSectionBackground,
        compSectionSpacing: compSupp.sectionSpacing,
      };
    });

    this.lastSectionKeys = context.sections.map(s => s.itemKeys ?? []);
    this._compEngine.computeSections(sections);
    this._cache.clearStash();

    // After computeSections(), populate H-section metadata from LayoutCache.
    // C++ wrote "h-section-wrapper-{sIdx}" and "h-section-cw-{sIdx}" entries.
    this.hSectionMetaArr = context.sections.map((sec, sIdx) => {
      if (!this.isHSection(sIdx)) return null;
      const prefix = this.keyPrefixForSection(sIdx);
      const wrapperAttrs = this._cache.getAttributes(`h-section-wrapper-${sIdx}`);
      const cwAttrs      = this._cache.getAttributes(`h-section-cw-${sIdx}`);

      // Fallback: scan last item for content width if cw entry is missing.
      let contentWidth = cwAttrs?.frame.width ?? 0;
      if (contentWidth <= 0 && sec.itemCount > 0) {
        const lastKey = sec.itemKeys?.[sec.itemCount - 1]
          ?? `${prefix}-${sIdx}-${sec.itemCount - 1}`;
        const lastItem = this._cache.getAttributes(lastKey);
        if (lastItem) contentWidth = lastItem.frame.x + lastItem.frame.width;
      }

      // flatBase must be the first DATA item's flat index (after header), not the
      // section start.  C++ stores data items at flatIndexBase + i where
      // flatIndexBase = sectionFlatBase + (hasHeader ? 1 : 0).  If flatBase
      // includes the header, the last data item falls outside [flatBase,
      // flatBase + itemCount) and is never excluded by H windowing.
      const hasHeader = sec.supplementaryItems.some(s => s.kind === 'header');
      const dataFlatBase = (sectionFlatBases[sIdx] ?? 0) + (hasHeader ? 1 : 0);

      return {
        sectionY:      wrapperAttrs?.frame.y  ?? 0,
        sectionHeight: wrapperAttrs?.frame.height ?? 0,
        flatBase:      dataFlatBase,
        itemCount:     sec.itemCount,
        contentWidth,
      };
    });
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    return this._cache.getAttributesInRect(inRect);
  }

  cacheKeyForItem(index: number, section: number): string {
    const sectionKeys = this.lastSectionKeys[section];
    const prefix = this.keyPrefixForSection(section);
    return sectionKeys?.[index] ?? `${prefix}-${section}-${index}`;
  }

  cacheKeyForSupplementary(kind: string, section: number): string {
    // Level 1: compositional-owned supplementaries use "comp-{section}-{kind}" key.
    return `comp-${section}-${kind}`;
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
    // Conservative: re-layout on width change (covers all vertical sub-layout types).
    return Math.abs(oldBounds.width - newBounds.width) > 0.5;
  }

  invalidationScope(): InvalidationScope {
    return { type: 'full' };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a compositional layout with per-section layout types.
 *
 * ```typescript
 * layout={compositional([
 *   { range: 0,      layout: list({ estimatedItemHeight: 200 }) },
 *   { range: 1,      layout: grid({ columns: 4, rowHeight: 80 }) },
 *   { range: [2, 3], layout: flow({ sizeForItem: tagSize }) },
 *   { range: 4,      layout: masonry({ columns: 2, heightForItem: h }) },
 * ])}
 * ```
 *
 * Last entry repeats for any sections beyond those explicitly listed.
 */
export function compositional(entries: CompositionalEntry[]): CollectionViewLayout {
  return new CompositionalLayoutEngine(entries);
}
