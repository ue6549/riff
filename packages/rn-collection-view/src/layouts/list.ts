/**
 * List Layout — single-column vertical layout factory.
 *
 * Creates a CollectionViewLayout backed by the C++ ListLayout engine.
 * Supports fixed height, estimated height with measurement, and per-item height callback.
 *
 * C++ layout writes to the shared LayoutCache. Spatial queries via getAttributesInRect.
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
  };
  listLayout: {
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

class ListLayout implements CollectionViewLayout {
  readonly type = 'list';
  private readonly delegate: ListLayoutDelegate;
  private lastContext: LayoutContext | null = null;
  private _lastFingerprint: string = '';
  private lastSectionKeys: (readonly string[])[] = [];

  constructor(delegate: ListLayoutDelegate) {
    this.delegate = delegate;
  }

  prepare(context: LayoutContext): void {
    this.lastContext = context;
    const d = this.delegate;

    // Build section params for C++ layout engine
    const sectionParams = context.sections.map((sec, sIdx) => {
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
        itemCount: sec.itemCount,
        itemHeight: (typeof d.itemHeight === 'function' ? d.itemHeight(context.containerWidth) : d.itemHeight) ?? d.estimatedItemHeight ?? 44,
        viewportWidth: context.containerWidth,
        sectionInsetTop: sec.insets?.top ?? 0,
        sectionInsetBottom: sec.insets?.bottom ?? 0,
        sectionInsetLeft: sec.insets?.left ?? 0,
        sectionInsetRight: sec.insets?.right ?? 0,
        itemSpacing: d.itemSpacing ?? 0,
        section: sIdx,
        headerHeight,
        footerHeight,
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

    listDebugLog(`[RNCVX-LIST] Sending to C++ nativeMod.listLayout.computeSections:`, sectionParams.map(s => ({ headerHeight: s.headerHeight, footerHeight: s.footerHeight, itemCount: s.itemCount })));

    // Build a fingerprint of the data shape. Only clear + recompute when it changes.
    // This preserves Yoga-measured heights across measurement-triggered re-renders.
    const fp = `${context.containerWidth}|${sectionParams.map(s => `${s.itemCount},${s.headerHeight},${s.footerHeight}`).join(';')}`;
    if (fp !== this._lastFingerprint) {
      nativeMod.layoutCache.clear();
      this._lastFingerprint = fp;
    }

    nativeMod.listLayout.computeSections(sectionParams);

    // Verification: immediately check if header was stored
    const headerCheck = nativeMod.layoutCache.getAttributes('item-0-header');
    const totalSize = nativeMod.layoutCache.getTotalContentSize();
    listDebugLog(`[RNCVX-LIST-VERIFY] After computeSections: item-0-header=${!!headerCheck} y=${headerCheck?.frame?.y} h=${headerCheck?.frame?.height} totalContentH=${totalSize?.height}`);
  }

  attributesForElements(inRect: Rect): LayoutAttributes[] {
    return nativeMod.layoutCache.getAttributesInRect(inRect);
  }

  attributesForItem(index: number, section: number): LayoutAttributes | null {
    const sectionKeys = this.lastSectionKeys[section];
    const key = sectionKeys?.[index] ?? `item-${section}-${index}`;
    return nativeMod.layoutCache.getAttributes(key);
  }

  attributesForSupplementary(kind: string, section: number): LayoutAttributes | null {
    const key = `item-${section}-${kind}`;
    return nativeMod.layoutCache.getAttributes(key);
  }

  contentSize(): Size {
    return nativeMod.layoutCache.getTotalContentSize();
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    // List layout invalidates when container width changes
    return Math.abs(oldBounds.width - newBounds.width) > 0.5;
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
      nativeMod.listLayout.invalidateListLayoutFrom(key, sectionParams[0]!);
    } else {
      // Find which section this key belongs to, invalidate from there
      const sectionIdx = parseInt(key.split('-')[1] ?? '0', 10);
      nativeMod.listLayout.invalidateSectionsFrom(sectionIdx, sectionParams);
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
