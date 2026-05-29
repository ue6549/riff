"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.radial = void 0;
var _NativeCollectionViewModule = _interopRequireDefault(require("../specs/NativeCollectionViewModule"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
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

const nativeMod = _NativeCollectionViewModule.default;
const TWO_PI = Math.PI * 2;
function scaleMatrix(s) {
  // Column-major 4x4 scale matrix.
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}
class RadialLayout {
  _cache = nativeMod.layoutCache;
  type = 'radial';
  horizontal = false;
  needsSpatialQuery = false;
  ctx = null;
  itemKeys = [];
  constructor(opts) {
    this.opts = {
      radius: opts.radius ?? 140,
      itemSize: opts.itemSize ?? 80,
      scrollPerRevolution: opts.scrollPerRevolution ?? 600,
      scrollHeight: opts.scrollHeight ?? 0,
      // resolved in prepare from container size
      topInset: opts.topInset ?? 40,
      minScale: opts.minScale ?? 0.55,
      minOpacity: opts.minOpacity ?? 0.35
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
    }, (_, i) => `radial-${i}`);
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
    const r = this.opts.radius;
    const sz = this.opts.itemSize;
    const cx = cw / 2;
    const cy = this.opts.topInset + r;
    const angleStep = TWO_PI / n;

    // Rotation phase derived from scroll offset.
    const phase = scrollY / this.opts.scrollPerRevolution * TWO_PI;
    const batch = new Array(n);
    for (let i = 0; i < n; i++) {
      const angle = i * angleStep + phase;
      // sin → 1 at the "front" (bottom of circle in screen coords); -1 at back.
      const front = (Math.sin(angle) + 1) * 0.5; // [0..1]
      const scale = this.opts.minScale + (1 - this.opts.minScale) * front;
      const opacity = this.opts.minOpacity + (1 - this.opts.minOpacity) * front;
      const zIndex = Math.round(front * 100);
      const x = cx + r * Math.cos(angle) - sz / 2;
      const y = cy + r * Math.sin(angle) - sz / 2 + scrollY;
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
    // Mount all items — a radial typically holds a small N (≤ 30).
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
    const w = cw;
    // Generous scroll budget so users get plenty of rotation runway.
    const h = this.opts.scrollHeight > 0 ? this.opts.scrollHeight : Math.max(ch * 4, 1200);
    return {
      width: w,
      height: h
    };
  }
  shouldInvalidate(oldBounds, newBounds) {
    return oldBounds.width !== newBounds.width || oldBounds.height !== newBounds.height;
  }
}
const radial = (opts = {}) => new RadialLayout(opts);
exports.radial = radial;
//# sourceMappingURL=radial.js.map