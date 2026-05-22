/**
 * List Layout — single-column vertical layout factory.
 *
 * Creates a CollectionViewLayout backed by the C++ ListLayout engine.
 * Supports fixed height, estimated height with measurement, and per-item height callback.
 *
 * C++ layout writes to the shared LayoutCache. Spatial queries via getAttributesInRect.
 *
 * ─── STABLE KEY RULE (enforce in every layout engine) ────────────────────────
 * One key per item, used identically in ALL three places:
 *   1. C++ LayoutCache write  — uses keys[i] when provided, else "{type}-{section}-{index}"
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
  ListLayoutDelegate,
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
    setHorizontal(horizontal: boolean): void;
    stashHeights(): void;
    stashMeasuredSizes(): void;
    clearStash(): void;
  };
  layoutCacheById(id: number): {
    getAttributesInRect(rect: { x: number; y: number; width: number; height: number }): LayoutAttributes[];
    getAttributes(key: string): LayoutAttributes | null;
    getTotalContentSize(): Size;
    clear(): void;
    setHorizontal(horizontal: boolean): void;
    stashHeights(): void;
    stashMeasuredSizes(): void;
    clearStash(): void;
  };
  listLayout: {
    computeListLayout(params: Record<string, unknown>): void;
    computeSections(sections: Record<string, unknown>[]): void;
    invalidateListLayoutFrom(key: string, params: Record<string, unknown>): void;
    invalidateSectionsFrom(idx: number, sections: Record<string, unknown>[]): void;
  };
  getListLayoutById(id: number): {
    computeListLayout(params: Record<string, unknown>): void;
    computeSections(sections: Record<string, unknown>[]): void;
    invalidateListLayoutFrom(key: string, params: Record<string, unknown>): void;
    invalidateSectionsFrom(idx: number, sections: Record<string, unknown>[]): void;
  };
};

const RNCV_LAYOUT_DEBUG_LOGS = false;
const listDebugLog = (...args: any[]) => {
  if (!__DEV__ || !RNCV_LAYOUT_DEBUG_LOGS) return;
  console.log(...args);
};

// Set RNCV_MVC_TRACE_LAYOUT=true to log fingerprint changes, stash/clear events,
// and the first 5 per-item height lookups passed to computeSections.
// Keep false in normal development.
const RNCV_MVC_TRACE_LAYOUT = false;
const listMvcTrace = (msg: string) => {
  if (!__DEV__ || !RNCV_MVC_TRACE_LAYOUT) return;
  console.log(`[MVC-TRACE] ${msg}`);
};

class ListLayout implements CollectionViewLayout {
  readonly type = 'list';
  readonly horizontal: boolean;
  readonly delegate: ListLayoutDelegate;
  private lastContext: LayoutContext | null = null;
  private _lastFingerprint: string = '';
  private lastSectionKeys: (readonly string[])[] = [];
  // B4.9: Per-instance cache + engine (set in prepare() via context.cacheId).
  private _cache = nativeMod.layoutCache;
  private _listEngine = nativeMod.listLayout;

  constructor(delegate: ListLayoutDelegate) {
    this.delegate = delegate;
    this.horizontal = delegate.horizontal ?? false;
  }

  prepare(context: LayoutContext): void {
    this.lastContext = context;
    // B4.9: Route to the per-instance cache/engine for this CollectionView.
    this._cache      = nativeMod.layoutCacheById(context.cacheId);
    this._listEngine = nativeMod.getListLayoutById(context.cacheId);
    const d = this.delegate;
    const H = this.horizontal;

    // Inform LayoutCache of scroll axis for MVC anchor computation.
    this._cache.setHorizontal(H);

    // Build section params for C++ layout engine.
    // Compute flat-index base per section so C++ can set flatIndex on each LayoutAttributes.
    let runningFlatBase = 0;
    const sectionParams = context.sections.map((sec, sIdx) => {
      const sectionFlatBase = runningFlatBase;
      const hasHeader = sec.supplementaryItems.some(s => s.kind === 'header');
      const hasFooter = sec.supplementaryItems.some(s => s.kind === 'footer');
      runningFlatBase += (hasHeader ? 1 : 0) + sec.itemCount + (hasFooter ? 1 : 0);

      // Determine item heights for this section.
      // Priority: measured (actual) → delegate heightForItem (estimate) → itemHeight → estimatedItemHeight.
      const w = context.containerWidth;
      let itemHeights: number[] | undefined;
      if (d.heightForItem || context.measuredHeightForItem) {
        itemHeights = [];
        for (let i = 0; i < sec.itemCount; i++) {
          const measured = context.measuredHeightForItem?.(i, sIdx);
          if (measured !== undefined) {
            itemHeights.push(measured);
          } else if (d.heightForItem) {
            itemHeights.push(d.heightForItem(i, sIdx, w));
          } else {
            itemHeights.push((typeof d.itemHeight === 'function' ? d.itemHeight(w) : d.itemHeight) ?? d.estimatedItemHeight ?? 44);
          }
        }
      }

      // Determine header height
      let headerHeight = 0;
      if (d.heightForHeader) {
        headerHeight = d.heightForHeader(sIdx);
      } else if (d.headerHeight != null) {
        headerHeight = d.headerHeight;
      } else if (d.estimatedHeaderHeight != null) {
        headerHeight = d.estimatedHeaderHeight;
      } else {
        // Check if section has a header supplementary
        const headerSup = sec.supplementaryItems.find(s => s.kind === 'header');
        if (headerSup) headerHeight = headerSup.size.height;
      }

      // Determine footer height
      let footerHeight = 0;
      if (d.heightForFooter) {
        footerHeight = d.heightForFooter(sIdx);
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
        itemHeight: (typeof d.itemHeight === 'function' ? d.itemHeight(context.containerWidth) : d.itemHeight) ?? d.estimatedItemHeight ?? 44,
        viewportWidth: context.containerWidth,
        viewportHeight: context.containerHeight,
        horizontal: H,
        sectionInsetTop: sec.insets?.top ?? 0,
        sectionInsetBottom: sec.insets?.bottom ?? 0,
        sectionInsetLeft: sec.insets?.left ?? 0,
        sectionInsetRight: sec.insets?.right ?? 0,
        itemSpacing: d.itemSpacing ?? 0,
        section: sIdx,
        headerHeight,
        footerHeight,
        // Decoration params — passed to C++ so it emits the right entries.
        // Separator color lives in JS; C++ only handles geometry.
        emitSectionBackground: d.sectionBackground === true,
        emitSeparators: d.separator != null,
        separatorHeight: d.separator?.height ?? 0.5,
        separatorInsetLeading: d.separator?.insetLeading ?? 0,
        separatorInsetTrailing: d.separator?.insetTrailing ?? 0,
        sectionSpacing: d.sectionSpacing ?? 0,
        // sectionBackground content insets — applied at C++ frame emission time.
        sectionBackgroundInsetTop:    d.sectionBackgroundContentInsets?.top    ?? 0,
        sectionBackgroundInsetBottom: d.sectionBackgroundContentInsets?.bottom ?? 0,
        sectionBackgroundInsetLeft:   d.sectionBackgroundContentInsets?.left   ?? 0,
        sectionBackgroundInsetRight:  d.sectionBackgroundContentInsets?.right  ?? 0,
        estimatedCrossAxisHeight: d.estimatedCrossAxisHeight ?? 200,
      };

      if (itemHeights) {
        params.itemHeights = itemHeights;
      }
      if (sec.itemKeys) {
        params.keys = sec.itemKeys;
      }

      return params;
    });

    this.lastSectionKeys = context.sections.map(s => s.itemKeys ?? []);

    listDebugLog(`[RNCVX-LIST] Sending to C++ this._listEngine.computeSections:`, sectionParams.map(s => ({ headerHeight: s.headerHeight, footerHeight: s.footerHeight, itemCount: s.itemCount })));

    // Build a fingerprint of the data shape. Only clear + recompute when it changes.
    // This preserves Yoga-measured heights/widths across measurement-triggered re-renders.
    // Only include the PRIMARY-axis container dimension in the fingerprint:
    //   Vertical: containerWidth (items need re-layout when width changes)
    //   Horizontal: containerHeight is excluded — cross-axis height changes from
    //   measurement are handled by applyMeasurements, not by clearing the cache.
    //   Including containerHeight caused: measure → cross-axis grows → fingerprint
    //   changes → clear → reset widths to estimates → re-measure → cascade → loop.
    const fpDim = H ? `w${context.containerWidth}` : `${context.containerWidth}x${context.containerHeight}`;
    const fp = `${fpDim}|${sectionParams.map(s => `${s.itemCount},${s.headerHeight},${s.footerHeight},${s.emitSeparators},${s.emitSectionBackground},${s.sectionBackgroundInsetTop},${s.sectionBackgroundInsetBottom},${s.sectionBackgroundInsetLeft},${s.sectionBackgroundInsetRight}`).join(';')}`;
    const fingerprintChanged = fp !== this._lastFingerprint;
    listMvcTrace(`prepare: fingerprintChanged=${fingerprintChanged} sections=${sectionParams.length} totalItems=${sectionParams.reduce((n, s) => n + (s.itemCount as number), 0)}`);
    if (fingerprintChanged) {
      // Stash measured sizes before computeSections so they survive the atomic
      // clear inside C++ ListLayout::computeSections (same pattern as Grid/Masonry/Flow).
      // Horizontal lists need both width (primary) and height (cross axis).
      // Vertical lists only need primary-axis height.
      listMvcTrace(`prepare: ${H ? 'stashMeasuredSizes' : 'stashHeights'} (fingerprint changed; clear happens atomically in C++)`);
      if (H) this._cache.stashMeasuredSizes();
      else this._cache.stashHeights();
      this._lastFingerprint = fp;
    }

    // Trace first 5 per-item heights per section as they'll be passed to C++.
    if (RNCV_MVC_TRACE_LAYOUT && __DEV__) {
      sectionParams.forEach((sec, sIdx) => {
        const itemHeights = sec.itemHeights as number[] | undefined;
        const first5 = itemHeights ? itemHeights.slice(0, 5) : [];
        listMvcTrace(`prepare: s[${sIdx}] itemCount=${sec.itemCount} itemHeights[0..4]=${JSON.stringify(first5)} (${itemHeights ? itemHeights.filter(h => h > 0).length : 0} non-zero)`);
      });
    }

    this._listEngine.computeSections(sectionParams);
    // Release stash memory now that computeSections has consumed what it needs.
    this._cache.clearStash();
    listMvcTrace(`prepare: computeSections done, stash cleared`);

    // Verification: immediately check if header was stored
    const headerCheck = this._cache.getAttributes('item-0-header');
    const totalSize = this._cache.getTotalContentSize();
    listDebugLog(`[RNCVX-LIST-VERIFY] After computeSections: item-0-header=${!!headerCheck} y=${headerCheck?.frame?.y} h=${headerCheck?.frame?.height} totalContentH=${totalSize?.height}`);
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    return this._cache.getAttributesInRect(inRect);
  }

  cacheKeyForItem(index: number, section: number): string {
    return this.lastSectionKeys[section]?.[index] ?? `item-${section}-${index}`;
  }

  cacheKeyForSupplementary(kind: string, section: number): string {
    return `item-${section}-${kind}`;
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
    // Vertical: invalidate when container width changes (items need new widths).
    // Horizontal: invalidate when container height changes (cross-axis resize).
    // Note: measurement-driven cross-axis changes are filtered by the fingerprint
    // in prepare() — it excludes cross-axis dimension for horizontal layouts, so
    // shouldInvalidate returning true won't cause a cache clear on measurement.
    return this.horizontal
      ? Math.abs(oldBounds.height - newBounds.height) > 0.5
      : Math.abs(oldBounds.width  - newBounds.width)  > 0.5;
  }

  invalidationScope(_oldBounds: Rect, _newBounds: Rect): InvalidationScope {
    return { type: 'full' };
  }

  invalidateFrom(key: string, context: LayoutContext): void {
    if (!this.lastContext) return;

    const sectionParams = context.sections.map((sec, sIdx) => {
      const params: Record<string, unknown> = {
        itemCount: sec.itemCount,
        itemHeight: (typeof this.delegate.itemHeight === 'function' ? this.delegate.itemHeight(context.containerWidth) : this.delegate.itemHeight) ?? this.delegate.estimatedItemHeight ?? 44,
        viewportWidth: context.containerWidth,
        itemSpacing: this.delegate.itemSpacing ?? 0,
        section: sIdx,
      };
      return params;
    });

    if (sectionParams.length === 1) {
      this._listEngine.invalidateListLayoutFrom(key, sectionParams[0]!);
    } else {
      // Find which section this key belongs to, invalidate from there
      const sectionIdx = parseInt(key.split('-')[1] ?? '0', 10);
      this._listEngine.invalidateSectionsFrom(sectionIdx, sectionParams);
    }
  }
}

/**
 * Create a list layout with the given delegate configuration.
 *
 * ```typescript
 * layout={list({ itemHeight: 44 })}
 * layout={list({ estimatedItemHeight: 60, stickyMode: 'push' })}
 * layout={list({ heightForItem: (i, s) => heights[i], itemSpacing: 8 })}
 * ```
 */
export function list(delegate: ListLayoutDelegate): CollectionViewLayout {
  return new ListLayout(delegate);
}
