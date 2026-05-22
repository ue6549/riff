/**
 * Spiral layout — items arranged on an Archimedean spiral. Vertical scroll
 * unwinds (or rewinds) the spiral by adding a phase offset, so items appear
 * to spiral outward from the centre.
 *
 * Pure-TypeScript, scroll-driven. One JSI batch per scroll tick.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={spiral({ a: 8, b: 12, itemSize: 60, scrollPerRevolution: 800 })}
 *     data={items}
 *     renderItem={({ item }) => <Bubble item={item} />}
 *     sectionIndex={4}
 *     crossAxisSize={500}
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

export interface SpiralOptions {
  /** Spiral starting radius in points. r = a + b * theta. Default: 8. */
  a?: number;
  /** Radial growth per radian. Bigger = looser spiral. Default: 12. */
  b?: number;
  /** Angular spacing between items in radians. Default: 0.5. */
  angularStep?: number;
  /** Item width and height (square). Default: 60. */
  itemSize?: number;
  /** Vertical scroll → angular phase mapping. Default: 800 (px/revolution). */
  scrollPerRevolution?: number;
  /** Vertical scroll budget. Default: 5 viewports. */
  scrollHeight?: number;
  /** Top inset above the spiral centre. Default: 80. */
  topInset?: number;
  /**
   * Minimum scale at the centre of the spiral (innermost items). Default: 0.4.
   * Outer items are scale 1.
   */
  minScale?: number;
}

const TWO_PI = Math.PI * 2;

/** Build a 4x4 column-major scale matrix. */
function scaleMatrix(s: number): readonly number[] {
  return [
    s, 0, 0, 0,
    0, s, 0, 0,
    0, 0, s, 0,
    0, 0, 0, 1,
  ];
}

class SpiralLayout implements CollectionViewLayout {
  readonly type = 'spiral';
  readonly horizontal = false;
  private _cache = nativeMod.layoutCache;
  readonly needsSpatialQuery = false;

  private readonly opts: Required<SpiralOptions>;
  private ctx: LayoutContext | null = null;
  private itemKeys: string[] = [];

  constructor(opts: SpiralOptions) {
    this.opts = {
      a:                   opts.a                   ?? 8,
      b:                   opts.b                   ?? 12,
      angularStep:         opts.angularStep         ?? 0.5,
      itemSize:            opts.itemSize            ?? 60,
      scrollPerRevolution: opts.scrollPerRevolution ?? 800,
      scrollHeight:        opts.scrollHeight        ?? 0,
      topInset:            opts.topInset            ?? 80,
      minScale:            opts.minScale            ?? 0.4,
    };
  }

  prepare(context: LayoutContext): void {
    this._cache = nativeMod.layoutCacheById(context.cacheId);
    this.ctx = context;
    const sec = context.sections[0];
    if (!sec) {
      this.itemKeys = [];
      return;
    }
    this.itemKeys = sec.itemKeys
      ? Array.from(sec.itemKeys)
      : Array.from({ length: sec.itemCount }, (_, i) => `spiral-${i}`);
    this._writeForOffset(0);
  }

  processScroll(offset: { x: number; y: number }, _ctx: LayoutContext): void {
    this._writeForOffset(offset.y);
  }

  private _writeForOffset(scrollY: number): void {
    if (!this.ctx) return;
    const n = this.itemKeys.length;
    if (n === 0) return;

    const cw = this.ctx.containerWidth;
    const sz = this.opts.itemSize;
    const cx = cw / 2;

    // Maximum radius for the outermost item determines centre Y.
    const maxTheta = (n - 1) * this.opts.angularStep;
    const maxR     = this.opts.a + this.opts.b * maxTheta;
    const cy       = this.opts.topInset + maxR;

    const phase = (scrollY / this.opts.scrollPerRevolution) * TWO_PI;
    const scaleStep = (1 - this.opts.minScale) / Math.max(1, n - 1);

    const batch: object[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const theta = i * this.opts.angularStep + phase;
      const r     = this.opts.a + this.opts.b * (i * this.opts.angularStep);

      const x = cx + r * Math.cos(theta) - sz / 2;
      const y = cy + r * Math.sin(theta) - sz / 2 + scrollY;

      // Outer items larger and more opaque than inner.
      const scale   = this.opts.minScale + scaleStep * i;
      const opacity = 0.5 + 0.5 * (i / Math.max(1, n - 1));
      const zIndex  = i;

      batch[i] = {
        key:     this.itemKeys[i],
        section: 0,
        index:   i,
        frame:   { x, y, width: sz, height: sz },
        zIndex,
        alpha:   opacity,
        transform3D: scaleMatrix(scale),
      };
    }
    this._cache.setAttributesBatch(batch);
  }

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
    const cw = this.ctx?.containerWidth ?? 0;
    const ch = this.ctx?.containerHeight ?? 0;
    const h  = this.opts.scrollHeight > 0 ? this.opts.scrollHeight : Math.max(ch * 5, 1500);
    return { width: cw, height: h };
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    return oldBounds.width !== newBounds.width || oldBounds.height !== newBounds.height;
  }
}

export type SpiralFactory = (opts?: SpiralOptions) => CollectionViewLayout;

export const spiral: SpiralFactory = (opts = {}) => new SpiralLayout(opts);
