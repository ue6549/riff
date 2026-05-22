/**
 * Hex layout — honeycomb tiling. Static (no scroll-driven recomputation).
 * Items are placed on an offset grid where every other row is shifted by
 * half a hex width.
 *
 * NOTE: shipped as TypeScript today for parity with radial/spiral/carousel3D.
 * A C++ port (HexLayoutEngine + registerLayoutEngine + TS shim) is a planned
 * follow-up to demonstrate native custom layouts using the same H-2 framework.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={hex({ hexSize: 56 })}
 *     data={items}
 *     renderItem={({ item }) => <HexCell item={item} />}
 *     sectionIndex={5}
 *     scrollDirection="none"
 *     crossAxisSize={400}
 *   />
 */

import type {
  CollectionViewLayout,
  LayoutContext,
} from '../types/protocol';
import type { LayoutAttributes, Rect, Size } from '../types';
import NativeCollectionViewModule from '../specs/NativeCollectionViewModule';

const nativeMod = NativeCollectionViewModule as unknown as {
  layoutCache: {
    setAttributes(attrs: object): void;
    setAttributesBatch(batch: object[]): void;
    getAttributes(key: string): LayoutAttributes | null;
  };
  layoutCacheById(id: number): {
    setAttributes(attrs: object): void;
    setAttributesBatch(batch: object[]): void;
    getAttributes(key: string): LayoutAttributes | null;
  };
};

export interface HexOptions {
  /** Edge-to-edge size of a hex cell. Default: 64. */
  hexSize?: number;
  /** Horizontal padding around the tiling. Default: 8. */
  paddingX?: number;
  /** Vertical padding above the tiling. Default: 8. */
  paddingY?: number;
  /** Spacing between hexes. Default: 4. */
  gap?: number;
}

class HexLayout implements CollectionViewLayout {
  readonly type = 'hex';
  readonly horizontal = false;
  readonly needsSpatialQuery = false;

  private readonly opts: Required<HexOptions>;
  private ctx: LayoutContext | null = null;
  private itemKeys: string[] = [];
  private _contentSize: Size = { width: 0, height: 0 };
  private _cache = nativeMod.layoutCache;

  constructor(opts: HexOptions) {
    this.opts = {
      hexSize:  opts.hexSize  ?? 64,
      paddingX: opts.paddingX ?? 8,
      paddingY: opts.paddingY ?? 8,
      gap:      opts.gap      ?? 4,
    };
  }

  prepare(context: LayoutContext): void {
    this._cache = nativeMod.layoutCacheById(context.cacheId);
    this.ctx = context;
    const sec = context.sections[0];
    if (!sec) {
      this.itemKeys = [];
      this._contentSize = { width: 0, height: 0 };
      return;
    }

    this.itemKeys = sec.itemKeys
      ? Array.from(sec.itemKeys)
      : Array.from({ length: sec.itemCount }, (_, i) => `hex-${i}`);

    const cw = context.containerWidth;
    const sz = this.opts.hexSize;
    const gap = this.opts.gap;

    // Pointy-top hex tiling math:
    //   horizontal stride = sz + gap (full width per hex on a row)
    //   vertical   stride = sz * 0.75 + gap (rows overlap by 25% of the hex)
    //   odd rows shifted by (sz + gap) / 2
    const colStride = sz + gap;
    const rowStride = sz * 0.75 + gap;

    const usableW = Math.max(0, cw - this.opts.paddingX * 2);
    const cols = Math.max(1, Math.floor((usableW + gap) / colStride));

    let maxBottom = 0;
    const batch: object[] = new Array(this.itemKeys.length);
    for (let i = 0; i < this.itemKeys.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const xOffset = (row % 2 === 1) ? colStride / 2 : 0;
      const x = this.opts.paddingX + col * colStride + xOffset;
      const y = this.opts.paddingY + row * rowStride;
      maxBottom = Math.max(maxBottom, y + sz);

      batch[i] = {
        key:     this.itemKeys[i],
        section: 0,
        index:   i,
        frame:   { x, y, width: sz, height: sz },
        zIndex:  0,
        alpha:   1,
      };
    }

    this._cache.setAttributesBatch(batch);
    this._contentSize = { width: cw, height: maxBottom + this.opts.paddingY };
  }

  // No processScroll — hex is a static layout.

  attributesForElements(_inRect: Rect): LayoutAttributes[] {
    const result: LayoutAttributes[] = [];
    for (let i = 0; i < this.itemKeys.length; i++) {
      const a = this._cache.getAttributes(this.itemKeys[i]);
      if (a) result.push(a);
    }
    return result;
  }

  attributesForItem(index: number, _section: number): LayoutAttributes | null {
    const k = this.itemKeys[index];
    return k ? this._cache.getAttributes(k) : null;
  }

  attributesForSupplementary(_kind: string, _section: number): LayoutAttributes | null {
    return null;
  }

  contentSize(): Size {
    return this._contentSize;
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    return oldBounds.width !== newBounds.width;
  }
}

export type HexFactory = (opts?: HexOptions) => CollectionViewLayout;

export const hex: HexFactory = (opts = {}) => new HexLayout(opts);
