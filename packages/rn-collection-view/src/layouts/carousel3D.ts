/**
 * Carousel3D layout — horizontal cover-flow style. Items are laid out in a
 * straight row but transformed with rotateY based on their distance from the
 * scroll-centre, with perspective foreshortening to give a 3D look.
 *
 * Pure-TypeScript, scroll-driven. One JSI batch per scroll tick.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={carousel3D({ itemSize: 220, gap: 24, perspective: 800 })}
 *     data={items}
 *     renderItem={({ item }) => <CardCover item={item} />}
 *     sectionIndex={3}
 *     crossAxisSize={300}
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

export interface Carousel3DOptions {
  /** Card width and height (square cards). Default: 220. */
  itemSize?: number;
  /** Spacing between cards along X. Default: 24. */
  gap?: number;
  /** Perspective distance in points. Smaller = more dramatic. Default: 800. */
  perspective?: number;
  /** Maximum rotation in degrees on either side. Default: 60. */
  maxRotation?: number;
  /**
   * Falloff distance — beyond this many points off-centre the card reaches
   * its full rotation. Default: itemSize * 1.5.
   */
  falloff?: number;
  /** Edge inset on the leading and trailing sides. Default: itemSize. */
  edgeInset?: number;
}

const DEG_TO_RAD = Math.PI / 180;

/** Build a 4x4 column-major matrix for rotateY(angleRad) with optional perspective. */
function buildRotationMatrix(angleRad: number, perspective: number): readonly number[] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const m34 = perspective > 0 ? -1 / perspective : 0;
  // rotateY (column-major):
  //   [  c  0  s  0]
  //   [  0  1  0  0]
  //   [ -s  0  c  0]
  //   [  0  0  0  1]
  // Apply perspective by setting m34. CATransform3D's m34 is the m[3][4] field
  // in row-major terms — at column-major index 11.
  return [
     c, 0, s, 0,
     0, 1, 0, 0,
    -s, 0, c, m34,
     0, 0, 0, 1,
  ];
}

class Carousel3DLayout implements CollectionViewLayout {
  private _cache = nativeMod.layoutCache;
  readonly type = 'carousel3D';
  readonly horizontal = true;
  readonly needsSpatialQuery = false;

  private readonly opts: Required<Carousel3DOptions>;
  private ctx: LayoutContext | null = null;
  private itemKeys: string[] = [];

  constructor(opts: Carousel3DOptions) {
    const itemSize = opts.itemSize ?? 220;
    this.opts = {
      itemSize,
      gap:         opts.gap         ?? 24,
      perspective: opts.perspective ?? 800,
      maxRotation: opts.maxRotation ?? 60,
      falloff:     opts.falloff     ?? itemSize * 1.5,
      edgeInset:   opts.edgeInset   ?? itemSize,
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
      : Array.from({ length: sec.itemCount }, (_, i) => `carousel3D-${i}`);
    this._writeForOffset(0);
  }

  processScroll(offset: { x: number; y: number }, _ctx: LayoutContext): void {
    this._writeForOffset(offset.x);
  }

  private _writeForOffset(scrollX: number): void {
    if (!this.ctx) return;
    const n = this.itemKeys.length;
    if (n === 0) return;

    const cw = this.ctx.containerWidth;
    const ch = this.ctx.containerHeight;
    const sz = this.opts.itemSize;
    const stride = sz + this.opts.gap;

    // Y centred along the cross axis.
    const y = Math.max(0, (ch - sz) / 2);
    const viewportCentreX = scrollX + cw / 2;

    const batch: object[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = this.opts.edgeInset + i * stride;
      const itemCentreX = x + sz / 2;
      const dx = itemCentreX - viewportCentreX;
      // Falloff: linearly map |dx|/falloff into [-1..1], clamped.
      const t = Math.max(-1, Math.min(1, dx / this.opts.falloff));
      const angleDeg = -t * this.opts.maxRotation;
      const angleRad = angleDeg * DEG_TO_RAD;

      // Z-front items get higher z so they paint over neighbours.
      const front = 1 - Math.abs(t); // [0..1]
      const zIndex = Math.round(front * 100);

      batch[i] = {
        key:     this.itemKeys[i],
        section: 0,
        index:   i,
        frame:   { x, y, width: sz, height: sz },
        zIndex,
        alpha:   0.45 + 0.55 * front,
        transform3D: buildRotationMatrix(angleRad, this.opts.perspective),
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
    const n = this.itemKeys.length;
    const stride = this.opts.itemSize + this.opts.gap;
    const totalW = this.opts.edgeInset * 2 + n * stride - this.opts.gap;
    return { width: Math.max(totalW, this.ctx?.containerWidth ?? 0), height: this.opts.itemSize };
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    return oldBounds.width !== newBounds.width || oldBounds.height !== newBounds.height;
  }
}

export type Carousel3DFactory = (opts?: Carousel3DOptions) => CollectionViewLayout;

export const carousel3D: Carousel3DFactory = (opts = {}) => new Carousel3DLayout(opts);
