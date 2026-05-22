/**
 * Radial layout — items arranged on a circle. Vertical scroll drives rotation
 * around the centre. Items further from the "front" (the viewport-bottom point
 * on the circle) get smaller and more transparent.
 *
 * This is a pure-TypeScript reference layout shipped with the framework.
 * Per scroll tick: 1 JSI round-trip via `setAttributesBatch` for all items.
 *
 * Usage:
 *   <CollectionSubContainer
 *     layout={radial({ radius: 140, itemSize: 80, scrollPerRevolution: 600 })}
 *     data={items}
 *     renderItem={({ item }) => <Card item={item} />}
 *     sectionIndex={2}
 *     crossAxisSize={360}
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
    clear(): void;
  };
  layoutCacheById(id: number): {
    setAttributes(attrs: object): void;
    setAttributesBatch(batch: object[]): void;
    getAttributes(key: string): LayoutAttributes | null;
    clear(): void;
  };
};

export interface RadialOptions {
  /** Radius of the item circle in points. Default: 140. */
  radius?: number;
  /** Item width and height in points. Default: 80. */
  itemSize?: number;
  /**
   * How much vertical scroll equals one full revolution of the circle (points).
   * Bigger = slower rotation. Default: 600.
   */
  scrollPerRevolution?: number;
  /** Total scrollable height (controls scroll budget). Default: 4 viewports. */
  scrollHeight?: number;
  /** Cross-axis (vertical) padding above the circle. Default: 40. */
  topInset?: number;
  /**
   * Minimum scale at the back of the circle. Items at the front are scale 1.
   * Default: 0.55.
   */
  minScale?: number;
  /**
   * Minimum opacity at the back of the circle. Items at the front are opaque.
   * Default: 0.35.
   */
  minOpacity?: number;
}

const TWO_PI = Math.PI * 2;

function scaleMatrix(s: number): readonly number[] {
  // Column-major 4x4 scale matrix.
  return [
    s, 0, 0, 0,
    0, s, 0, 0,
    0, 0, s, 0,
    0, 0, 0, 1,
  ];
}

class RadialLayout implements CollectionViewLayout {
  private _cache = nativeMod.layoutCache;
  readonly type = 'radial';
  readonly horizontal = false;
  readonly needsSpatialQuery = false;

  private readonly opts: Required<RadialOptions>;
  private ctx: LayoutContext | null = null;
  private itemKeys: string[] = [];

  constructor(opts: RadialOptions) {
    this.opts = {
      radius:              opts.radius              ?? 140,
      itemSize:            opts.itemSize            ?? 80,
      scrollPerRevolution: opts.scrollPerRevolution ?? 600,
      scrollHeight:        opts.scrollHeight        ?? 0,    // resolved in prepare from container size
      topInset:            opts.topInset            ?? 40,
      minScale:            opts.minScale            ?? 0.55,
      minOpacity:          opts.minOpacity          ?? 0.35,
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
      : Array.from({ length: sec.itemCount }, (_, i) => `radial-${i}`);
    this._writeForOffset(0);
  }

  processScroll(offset: { x: number; y: number }, _ctx: LayoutContext): void {
    this._writeForOffset(offset.y);
  }

  private _writeForOffset(scrollY: number): void {
    if (!this.ctx) return;
    const n = this.itemKeys.length;
    if (n === 0) return;

    const cw   = this.ctx.containerWidth;
    const r    = this.opts.radius;
    const sz   = this.opts.itemSize;
    const cx   = cw / 2;
    const cy   = this.opts.topInset + r;
    const angleStep = TWO_PI / n;

    // Rotation phase derived from scroll offset.
    const phase = (scrollY / this.opts.scrollPerRevolution) * TWO_PI;

    const batch: object[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const angle = i * angleStep + phase;
      // sin → 1 at the "front" (bottom of circle in screen coords); -1 at back.
      const front = (Math.sin(angle) + 1) * 0.5; // [0..1]
      const scale   = this.opts.minScale  + (1 - this.opts.minScale)  * front;
      const opacity = this.opts.minOpacity + (1 - this.opts.minOpacity) * front;
      const zIndex  = Math.round(front * 100);

      const x = cx + r * Math.cos(angle) - sz / 2;
      const y = cy + r * Math.sin(angle) - sz / 2 + scrollY;

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
    // Mount all items — a radial typically holds a small N (≤ 30).
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
    const w  = cw;
    // Generous scroll budget so users get plenty of rotation runway.
    const h  = this.opts.scrollHeight > 0 ? this.opts.scrollHeight : Math.max(ch * 4, 1200);
    return { width: w, height: h };
  }

  shouldInvalidate(oldBounds: Rect, newBounds: Rect): boolean {
    return oldBounds.width !== newBounds.width || oldBounds.height !== newBounds.height;
  }
}

export type RadialLayoutFactory = (opts?: RadialOptions) => CollectionViewLayout;

export const radial: RadialLayoutFactory = (opts = {}) => new RadialLayout(opts);
