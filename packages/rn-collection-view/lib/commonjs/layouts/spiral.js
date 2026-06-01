"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.spiral = void 0;
var _NativeCollectionViewModule = _interopRequireDefault(require("../specs/NativeCollectionViewModule"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
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

const nativeMod = _NativeCollectionViewModule.default;
const TWO_PI = Math.PI * 2;

/** Build a 4x4 column-major scale matrix. */
function scaleMatrix(s) {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}
class SpiralLayout {
  type = 'spiral';
  horizontal = false;
  _cache = nativeMod.layoutCache;
  needsSpatialQuery = false;
  ctx = null;
  itemKeys = [];
  constructor(opts) {
    this.opts = {
      a: opts.a ?? 8,
      b: opts.b ?? 12,
      angularStep: opts.angularStep ?? 0.5,
      itemSize: opts.itemSize ?? 60,
      scrollPerRevolution: opts.scrollPerRevolution ?? 800,
      scrollHeight: opts.scrollHeight ?? 0,
      topInset: opts.topInset ?? 80,
      minScale: opts.minScale ?? 0.4
    };
  }
  prepare(context) {
    this._cache = nativeMod.layoutCacheById(context.cacheId);
    this.ctx = context;
    const sec = context.sections[0];
    if (!sec) {
      this.itemKeys = [];
      return;
    }
    this.itemKeys = sec.itemKeys ? Array.from(sec.itemKeys) : Array.from({
      length: sec.itemCount
    }, (_, i) => `spiral-${i}`);
    this._writeForOffset(0);
  }
  processScroll(offset, _ctx) {
    this._writeForOffset(offset.y);
  }
  _writeForOffset(scrollY) {
    if (!this.ctx) return;
    const n = this.itemKeys.length;
    if (n === 0) return;
    const cw = this.ctx.containerWidth;
    const sz = this.opts.itemSize;
    const cx = cw / 2;

    // Maximum radius for the outermost item determines centre Y.
    const maxTheta = (n - 1) * this.opts.angularStep;
    const maxR = this.opts.a + this.opts.b * maxTheta;
    const cy = this.opts.topInset + maxR;
    const phase = scrollY / this.opts.scrollPerRevolution * TWO_PI;
    const scaleStep = (1 - this.opts.minScale) / Math.max(1, n - 1);
    const batch = new Array(n);
    for (let i = 0; i < n; i++) {
      const theta = i * this.opts.angularStep + phase;
      const r = this.opts.a + this.opts.b * (i * this.opts.angularStep);
      const x = cx + r * Math.cos(theta) - sz / 2;
      const y = cy + r * Math.sin(theta) - sz / 2 + scrollY;

      // Outer items larger and more opaque than inner.
      const scale = this.opts.minScale + scaleStep * i;
      const opacity = 0.5 + 0.5 * (i / Math.max(1, n - 1));
      const zIndex = i;
      batch[i] = {
        key: this.itemKeys[i],
        section: 0,
        index: i,
        frame: {
          x,
          y,
          width: sz,
          height: sz
        },
        zIndex,
        alpha: opacity,
        transform3D: scaleMatrix(scale)
      };
    }
    this._cache.setAttributesBatch(batch);
  }
  attributesForElements(_inRect) {
    const result = [];
    for (let i = 0; i < this.itemKeys.length; i++) {
      const a = this._cache.getAttributes(this.itemKeys[i]);
      if (a) result.push(a);
    }
    return result;
  }
  attributesForItem(index, _section) {
    const k = this.itemKeys[index];
    return k ? this._cache.getAttributes(k) : null;
  }
  attributesForSupplementary(_kind, _section) {
    return null;
  }
  contentSize() {
    const cw = this.ctx?.containerWidth ?? 0;
    const ch = this.ctx?.containerHeight ?? 0;
    const h = this.opts.scrollHeight > 0 ? this.opts.scrollHeight : Math.max(ch * 5, 1500);
    return {
      width: cw,
      height: h
    };
  }
  shouldInvalidate(oldBounds, newBounds) {
    return oldBounds.width !== newBounds.width || oldBounds.height !== newBounds.height;
  }
}
const spiral = (opts = {}) => new SpiralLayout(opts);
exports.spiral = spiral;
//# sourceMappingURL=spiral.js.map